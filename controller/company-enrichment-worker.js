const {
  getPendingEnrichmentRecords,
  updateDeliveryRecordEnrichment,
  markDeliveryRecordEnrichmentStatus,
  getCompanyProfileCacheByLookupFingerprint,
  getCompanyProfileCacheByIdentifier,
  getCompanyProfileCacheByNormalizedName,
  upsertCompanyProfileCache
} = require('./db');
const { normalizeCompanyName } = require('./company-normalizer');
const { ensureSourceDecision, fetchCompanyProfile, buildLookupContext } = require('./company-profile-fetcher');

const ENRICHMENT_POLL_INTERVAL_MS = Number(process.env.COMPANY_ENRICHMENT_POLL_INTERVAL_MS || 20 * 1000);
const ENRICHMENT_BATCH_SIZE = Number(process.env.COMPANY_ENRICHMENT_BATCH_SIZE || 10);
const RESOLVED_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NOT_FOUND_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000];

let timer = null;
let isRunning = false;

async function processPendingRecords() {
  if (isRunning) {
    return;
  }

  isRunning = true;
  try {
    const records = getPendingEnrichmentRecords(ENRICHMENT_BATCH_SIZE);
    if (records.length > 0) {
      const sampleNames = records
        .map((record) => record?.payload?.['公司名称'])
        .filter(Boolean)
        .slice(0, 3);
      await ensureSourceDecision(sampleNames);
    }

    for (const record of records) {
      await processRecord(record);
    }
  } catch (error) {
    console.error(`[CompanyEnrichmentWorker] Tick failed: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

async function processRecord(record) {
  const payload = isObject(record.payload) ? { ...record.payload } : {};
  const lookupContext = buildLookupContext({
    companyNameRaw: payload['公司名称'],
    industry: payload['行业领域'],
    scale: payload['公司规模'],
    location: payload['工作地点'],
    companyIdentifier: payload.encryptBrandId
  });
  const companyNameRaw = lookupContext.companyNameRaw;
  const companyIdentifier = lookupContext.companyIdentifier;
  const companyNameNormalized = lookupContext.companyNameNormalized;
  const deadlineAt = resolveDeadline(record);

  if (!companyNameNormalized) {
    const fallbackStatus = deriveEnrichmentStatus(payload, 'not_found');
    updateDeliveryRecordEnrichment(record.id, { payload, enrichmentStatus: fallbackStatus });
    return;
  }

  const cache = findBestCache(lookupContext);
  if (isFreshCache(cache)) {
    const nextPayload = applyProfileToPayload(payload, cache);
    const nextStatus = deriveEnrichmentStatus(nextPayload, cache.status);
    updateDeliveryRecordEnrichment(record.id, { payload: nextPayload, enrichmentStatus: nextStatus });
    return;
  }

  const now = Date.now();
  if (cache?.nextRetryAt && new Date(cache.nextRetryAt).getTime() > now) {
    if (deadlineAt <= now) {
      const timeoutStatus = deriveEnrichmentStatus(payload, 'not_found');
      updateDeliveryRecordEnrichment(record.id, { payload, enrichmentStatus: timeoutStatus });
    } else {
      markDeliveryRecordEnrichmentStatus(record.id, 'failed');
    }
    return;
  }

  if (deadlineAt <= now) {
    const timeoutStatus = deriveEnrichmentStatus(payload, 'not_found');
    updateDeliveryRecordEnrichment(record.id, { payload, enrichmentStatus: timeoutStatus });
    return;
  }

  const attemptCount = Number(cache?.attemptCount || 0) + 1;
  const fetchResult = await fetchCompanyProfile(lookupContext);

  if (fetchResult.status === 'failed') {
    const nextRetryAt = computeRetryAt(attemptCount);
    upsertCompanyProfileCache({
      companyNameRaw,
      companyNameNormalized,
      companyLookupFingerprint: lookupContext.companyLookupFingerprint,
      companyIdentifier: companyIdentifier || null,
      companyType: '',
      companyDescription: '',
      source: fetchResult.source || null,
      sourceUrl: fetchResult.sourceUrl || null,
      status: 'failed',
      attemptCount,
      lastError: fetchResult.reason || 'unknown_error',
      nextRetryAt
    });

    if (deadlineAt <= Date.now()) {
      const timeoutStatus = deriveEnrichmentStatus(payload, 'not_found');
      updateDeliveryRecordEnrichment(record.id, { payload, enrichmentStatus: timeoutStatus });
    } else {
      markDeliveryRecordEnrichmentStatus(record.id, 'failed');
    }
    return;
  }

  upsertCompanyProfileCache({
    companyNameRaw,
    companyNameNormalized,
    companyLookupFingerprint: lookupContext.companyLookupFingerprint,
    companyIdentifier: companyIdentifier || null,
    companyType: fetchResult.companyType || '',
    companyDescription: fetchResult.companyDescription || '',
    source: fetchResult.source || null,
    sourceUrl: fetchResult.sourceUrl || null,
    status: fetchResult.status,
    attemptCount,
    lastError: null,
    nextRetryAt: null,
    resolvedAt: fetchResult.status === 'not_found' ? null : new Date().toISOString()
  });

  const nextPayload = applyProfileToPayload(payload, fetchResult);
  const nextStatus = deriveEnrichmentStatus(nextPayload, fetchResult.status);
  updateDeliveryRecordEnrichment(record.id, { payload: nextPayload, enrichmentStatus: nextStatus });
}

function start() {
  if (timer) {
    return;
  }

  timer = setInterval(() => {
    processPendingRecords().catch((error) => {
      console.error(`[CompanyEnrichmentWorker] Unhandled tick error: ${error.message}`);
    });
  }, ENRICHMENT_POLL_INTERVAL_MS);

  console.log(`[CompanyEnrichmentWorker] Started (interval=${ENRICHMENT_POLL_INTERVAL_MS}ms, batchSize=${ENRICHMENT_BATCH_SIZE})`);
  processPendingRecords().catch((error) => {
    console.error(`[CompanyEnrichmentWorker] Initial tick failed: ${error.message}`);
  });
}

function stop() {
  if (!timer) {
    return;
  }

  clearInterval(timer);
  timer = null;
  console.log('[CompanyEnrichmentWorker] Stopped');
}

function findBestCache(lookupContext) {
  if (lookupContext.companyLookupFingerprint) {
    const byFingerprint = getCompanyProfileCacheByLookupFingerprint(lookupContext.companyLookupFingerprint);
    if (byFingerprint) {
      return byFingerprint;
    }
  }

  if (lookupContext.companyIdentifier) {
    const byIdentifier = getCompanyProfileCacheByIdentifier(lookupContext.companyIdentifier);
    if (byIdentifier) {
      return byIdentifier;
    }
  }
  return getCompanyProfileCacheByNormalizedName(lookupContext.companyNameNormalized);
}

function isFreshCache(cache) {
  if (!cache || !cache.status || !cache.updatedAt) {
    return false;
  }

  const updatedAt = new Date(cache.updatedAt).getTime();
  if (Number.isNaN(updatedAt)) {
    return false;
  }

  const ageMs = Date.now() - updatedAt;
  if (cache.status === 'resolved' || cache.status === 'partial') {
    return ageMs <= RESOLVED_CACHE_TTL_MS;
  }
  if (cache.status === 'not_found') {
    return ageMs <= NOT_FOUND_CACHE_TTL_MS;
  }
  return false;
}

function applyProfileToPayload(payload, profile) {
  const nextPayload = { ...payload };
  if (!cleanString(nextPayload['公司类型']) && cleanString(profile.companyType)) {
    nextPayload['公司类型'] = cleanString(profile.companyType);
  }
  if (!cleanString(nextPayload['公司简介']) && cleanString(profile.companyDescription)) {
    nextPayload['公司简介'] = cleanString(profile.companyDescription);
  }
  return nextPayload;
}

function deriveEnrichmentStatus(payload, fallbackStatus = 'not_found') {
  const hasType = Boolean(cleanString(payload['公司类型']));
  const hasDescription = Boolean(cleanString(payload['公司简介']));

  if (hasType && hasDescription) {
    return 'resolved';
  }
  if (hasType || hasDescription) {
    return 'partial';
  }
  return fallbackStatus === 'failed' ? 'failed' : 'not_found';
}

function resolveDeadline(record) {
  const deadlineCandidate = record.enrichmentDeadlineAt || record.createdAt;
  const deadlineMs = deadlineCandidate ? new Date(deadlineCandidate).getTime() : NaN;
  if (!Number.isNaN(deadlineMs) && record.enrichmentDeadlineAt) {
    return deadlineMs;
  }
  if (!Number.isNaN(deadlineMs)) {
    return deadlineMs + 5 * 60 * 1000;
  }
  return Date.now() + 5 * 60 * 1000;
}

function computeRetryAt(attemptCount) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, attemptCount - 1));
  return new Date(Date.now() + RETRY_DELAYS_MS[index]).toISOString();
}

function cleanString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  start,
  stop,
  isStarted: () => Boolean(timer),
  processPendingRecords
};
