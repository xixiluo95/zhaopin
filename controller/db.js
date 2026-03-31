const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { normalizeCompanyName } = require('./company-normalizer');

const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'zhaopin.db');
const QUEUE_FILE = path.join(__dirname, 'task_queue.json');
const SCHEMA_VERSION = 14;

let dbInstance = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function initDatabase(dbPath = DEFAULT_DB_PATH) {
  if (dbInstance) {
    return dbInstance;
  }

  ensureDataDir();

  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');

  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS delivery_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      source_task_id TEXT,
      source_batch_id TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      last_attempt_at TEXT,
      next_retry_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      CONSTRAINT uq_dedupe UNIQUE (dedupe_key)
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_status
      ON delivery_queue (status);
    CREATE INDEX IF NOT EXISTS idx_delivery_next_retry
      ON delivery_queue (next_retry_at)
      WHERE status IN ('pending', 'retrying');
    CREATE INDEX IF NOT EXISTS idx_delivery_created
      ON delivery_queue (created_at);

    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT
    );
  `);

  const existingVersion = dbInstance
    .prepare('SELECT MAX(version) AS version FROM schema_version')
    .get();

  let currentVersion = existingVersion?.version || 0;
  if (!existingVersion || !existingVersion.version) {
    dbInstance
      .prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
      .run(1, 'Phase 1 delivery_queue baseline');
    currentVersion = 1;
  }

    if (currentVersion < 2) {
    migrateToV2(dbInstance);
    currentVersion = 2;
  }

  if (currentVersion < 3) {
    migrateToV3(dbInstance);
    currentVersion = 3;
  }

  if (currentVersion < 4) {
    migrateToV4(dbInstance);
  }

  if (currentVersion < 5) {
    migrateToV5(dbInstance);
    currentVersion = 5;
  }

  if (currentVersion < 6) {
    migrateToV6(dbInstance);
    currentVersion = 6;
  }

  if (currentVersion < 7) {
    migrateToV7(dbInstance);
    currentVersion = 7;
  }

  if (currentVersion < 8) {
    migrateToV8(dbInstance);
    currentVersion = 8;
  }

  if (currentVersion < 9) {
    migrateToV9(dbInstance);
    currentVersion = 9;
  }

  if (currentVersion < 10) {
    migrateToV10(dbInstance);
    currentVersion = 10;
  }

  if (currentVersion < 11) {
    migrateToV11(dbInstance);
    currentVersion = 11;
  }

  if (currentVersion < 12) {
    migrateToV12(dbInstance);
    currentVersion = 12;
  }

  if (currentVersion < 13) {
    migrateToV13(dbInstance);
    currentVersion = 13;
  }

  if (currentVersion < 14) {
    migrateToV14(dbInstance);
    currentVersion = 14;
  }

  // 断点恢复：重启后将 running 状态的页码任务重置为 pending
  resetRunningPageTasks();

  return dbInstance;
}

function getDatabase() {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

function insertDeliveryRecord({ dedupeKey, sourceTaskId = null, sourceBatchId = null, payload, deliveryTarget = null }) {
  const db = getDatabase();
  const payloadText = typeof payload === 'string' ? payload : JSON.stringify(payload);

  try {
    const result = db.prepare(`
      INSERT OR IGNORE INTO delivery_queue (
        dedupe_key,
        source_task_id,
        source_batch_id,
        payload,
        delivery_target,
        enrichment_status,
        enrichment_updated_at,
        enrichment_deadline_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now', '+5 minutes'))
    `).run(dedupeKey, sourceTaskId, sourceBatchId, payloadText, deliveryTarget);

    if (result.changes === 0) {
      return { success: false, error: 'Duplicate dedupe_key', code: 'DUPLICATE' };
    }

    return { success: true, id: result.lastInsertRowid };
  } catch (error) {
    return { success: false, error: error.message, code: 'DB_ERROR' };
  }
}

function getDeliveryStats() {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM delivery_queue
    GROUP BY status
  `).all();

  const stats = {
    pending: 0,
    retrying: 0,
    sent: 0,
    failed: 0,
    abandoned: 0,
    total: 0,
    oldestPendingAge: 0,
    oldestPendingCreatedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null
  };

  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(stats, row.status)) {
      stats[row.status] = row.count;
    }
    stats.total += row.count;
  }

  const oldestPending = db.prepare(`
    SELECT created_at
    FROM delivery_queue
    WHERE status IN ('pending', 'retrying')
    ORDER BY created_at ASC
    LIMIT 1
  `).get();

  if (oldestPending?.created_at) {
    const createdAt = normalizeSqliteDate(oldestPending.created_at);
    stats.oldestPendingCreatedAt = createdAt;
    stats.oldestPendingAge = Math.max(0, Date.now() - new Date(createdAt).getTime());
  }

  const lastSuccess = db.prepare(`
    SELECT COALESCE(sent_at, updated_at) AS timestamp
    FROM delivery_queue
    WHERE status = 'sent'
    ORDER BY COALESCE(sent_at, updated_at) DESC
    LIMIT 1
  `).get();
  if (lastSuccess?.timestamp) {
    stats.lastSuccessAt = normalizeSqliteDate(lastSuccess.timestamp);
  }

  const lastFailure = db.prepare(`
    SELECT updated_at AS timestamp
    FROM delivery_queue
    WHERE status IN ('failed', 'abandoned')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get();
  if (lastFailure?.timestamp) {
    stats.lastFailureAt = normalizeSqliteDate(lastFailure.timestamp);
  }

  return stats;
}

function getDeliveryRecords({ status, limit = 20, offset = 0 }) {
  const db = getDatabase();
  const normalizedLimit = normalizePositiveInteger(limit, 20, 1, 100);
  const normalizedOffset = normalizePositiveInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const statuses = normalizeStatuses(status);

  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT
      id,
      dedupe_key AS dedupeKey,
      source_task_id AS sourceTaskId,
      source_batch_id AS sourceBatchId,
      payload,
      delivery_target AS deliveryTarget,
      status,
      attempt_count AS attemptCount,
      max_attempts AS maxAttempts,
      last_error AS lastError,
      last_attempt_at AS lastAttemptAt,
      next_retry_at AS nextRetryAt,
      created_at AS createdAt,
      updated_at AS updatedAt,
      sent_at AS sentAt,
      enrichment_status AS enrichmentStatus,
      enrichment_updated_at AS enrichmentUpdatedAt,
      enrichment_deadline_at AS enrichmentDeadlineAt
    FROM delivery_queue
    WHERE status IN (${placeholders})
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...statuses, normalizedLimit, normalizedOffset);

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM delivery_queue
    WHERE status IN (${placeholders})
  `).get(...statuses);

  return {
    total: totalRow?.count || 0,
    limit: normalizedLimit,
    offset: normalizedOffset,
    statuses,
    records: rows.map((row) => ({
      ...row,
      payload: safeJsonParse(row.payload),
      lastAttemptAt: row.lastAttemptAt ? normalizeSqliteDate(row.lastAttemptAt) : null,
      nextRetryAt: row.nextRetryAt ? normalizeSqliteDate(row.nextRetryAt) : null,
      createdAt: row.createdAt ? normalizeSqliteDate(row.createdAt) : null,
      updatedAt: row.updatedAt ? normalizeSqliteDate(row.updatedAt) : null,
      sentAt: row.sentAt ? normalizeSqliteDate(row.sentAt) : null,
      enrichmentUpdatedAt: row.enrichmentUpdatedAt ? normalizeSqliteDate(row.enrichmentUpdatedAt) : null,
      enrichmentDeadlineAt: row.enrichmentDeadlineAt ? normalizeSqliteDate(row.enrichmentDeadlineAt) : null
    }))
  };
}

function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function getPendingDeliveryRecords(limit = 5) {
  const db = getDatabase();
  const normalizedLimit = normalizePositiveInteger(limit, 5, 1, 100);

  const rows = db.prepare(`
    SELECT
      id,
      dedupe_key AS dedupeKey,
      source_task_id AS sourceTaskId,
      source_batch_id AS sourceBatchId,
      payload,
      delivery_target AS deliveryTarget,
      status,
      attempt_count AS attemptCount,
      max_attempts AS maxAttempts,
      last_error AS lastError,
      last_attempt_at AS lastAttemptAt,
      next_retry_at AS nextRetryAt,
      created_at AS createdAt,
      updated_at AS updatedAt,
      sent_at AS sentAt,
      enrichment_status AS enrichmentStatus,
      enrichment_updated_at AS enrichmentUpdatedAt,
      enrichment_deadline_at AS enrichmentDeadlineAt
    FROM delivery_queue
    WHERE status IN ('pending', 'retrying')
      AND enrichment_status IN ('resolved', 'partial', 'not_found')
      AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(normalizedLimit);

  return rows.map((row) => ({
    ...row,
    payload: safeJsonParse(row.payload),
    lastAttemptAt: row.lastAttemptAt ? normalizeSqliteDate(row.lastAttemptAt) : null,
    nextRetryAt: row.nextRetryAt ? normalizeSqliteDate(row.nextRetryAt) : null,
    createdAt: row.createdAt ? normalizeSqliteDate(row.createdAt) : null,
    updatedAt: row.updatedAt ? normalizeSqliteDate(row.updatedAt) : null,
    sentAt: row.sentAt ? normalizeSqliteDate(row.sentAt) : null,
    enrichmentUpdatedAt: row.enrichmentUpdatedAt ? normalizeSqliteDate(row.enrichmentUpdatedAt) : null,
    enrichmentDeadlineAt: row.enrichmentDeadlineAt ? normalizeSqliteDate(row.enrichmentDeadlineAt) : null
  }));
}

function getPendingEnrichmentRecords(limit = 20) {
  const db = getDatabase();
  const normalizedLimit = normalizePositiveInteger(limit, 20, 1, 200);
  const rows = db.prepare(`
    SELECT
      id,
      dedupe_key AS dedupeKey,
      source_task_id AS sourceTaskId,
      source_batch_id AS sourceBatchId,
      payload,
      delivery_target AS deliveryTarget,
      status,
      created_at AS createdAt,
      updated_at AS updatedAt,
      enrichment_status AS enrichmentStatus,
      enrichment_updated_at AS enrichmentUpdatedAt,
      enrichment_deadline_at AS enrichmentDeadlineAt
    FROM delivery_queue
    WHERE status IN ('pending', 'retrying')
      AND enrichment_status IN ('pending', 'failed')
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(normalizedLimit);

  return rows.map((row) => ({
    ...row,
    payload: safeJsonParse(row.payload),
    createdAt: row.createdAt ? normalizeSqliteDate(row.createdAt) : null,
    updatedAt: row.updatedAt ? normalizeSqliteDate(row.updatedAt) : null,
    enrichmentUpdatedAt: row.enrichmentUpdatedAt ? normalizeSqliteDate(row.enrichmentUpdatedAt) : null,
    enrichmentDeadlineAt: row.enrichmentDeadlineAt ? normalizeSqliteDate(row.enrichmentDeadlineAt) : null
  }));
}

function updateDeliveryRecordEnrichment(id, { payload, enrichmentStatus, enrichmentUpdatedAt = null, enrichmentDeadlineAt = null }) {
  const db = getDatabase();
  const payloadText = typeof payload === 'string' ? payload : JSON.stringify(payload);
  db.prepare(`
    UPDATE delivery_queue
    SET
      payload = ?,
      enrichment_status = ?,
      enrichment_updated_at = COALESCE(?, datetime('now')),
      enrichment_deadline_at = COALESCE(?, enrichment_deadline_at),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(payloadText, enrichmentStatus, enrichmentUpdatedAt, enrichmentDeadlineAt, id);
}

function markDeliveryRecordEnrichmentStatus(id, enrichmentStatus) {
  const db = getDatabase();
  db.prepare(`
    UPDATE delivery_queue
    SET
      enrichment_status = ?,
      enrichment_updated_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(enrichmentStatus, id);
}

function updateDeliveryPayloadCompanyFieldsByNormalizedName(companyNameNormalized, { companyType = '', companyDescription = '' } = {}) {
  const normalizedName = normalizeCompanyName(companyNameNormalized);
  if (!normalizedName) {
    return 0;
  }

  const nextType = cleanPayloadString(companyType);
  const nextDescription = cleanPayloadString(companyDescription);
  if (!nextType && !nextDescription) {
    return 0;
  }

  const db = getDatabase();

  const selectStmt = db.prepare(`
    SELECT id, payload, enrichment_status AS enrichmentStatus
    FROM delivery_queue
    WHERE (?1 IS NULL OR id < ?1)
    ORDER BY id DESC
    LIMIT 500
  `);

  const updateStmt = db.prepare(`
    UPDATE delivery_queue
    SET
      payload = ?,
      enrichment_status = ?,
      enrichment_updated_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `);

  let updatedCount = 0;
  let lastId = null;

  while (true) {
    const rows = selectStmt.all(lastId);
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      lastId = row.id;

      const payload = safeJsonParse(row.payload);
      if (!payload || typeof payload !== 'object') {
        continue;
      }

      if (normalizeCompanyName(payload['公司名称']) !== normalizedName) {
        continue;
      }

      let changed = false;
      if (!cleanPayloadString(payload['公司类型']) && nextType) {
        payload['公司类型'] = nextType;
        changed = true;
      }
      if (!cleanPayloadString(payload['公司简介']) && nextDescription) {
        payload['公司简介'] = nextDescription;
        changed = true;
      }

      if (!changed) {
        continue;
      }

      updateStmt.run(
        JSON.stringify(payload),
        derivePayloadEnrichmentStatus(payload, row.enrichmentStatus),
        row.id
      );
      updatedCount += 1;
    }
  }

  return updatedCount;
}

function getCompanyProfileCacheByIdentifier(companyIdentifier) {
  if (!companyIdentifier) {
    return null;
  }

  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      id,
      company_name_raw AS companyNameRaw,
      company_name_normalized AS companyNameNormalized,
      company_identifier AS companyIdentifier,
      company_type AS companyType,
      company_description AS companyDescription,
      source,
      source_url AS sourceUrl,
      status,
      attempt_count AS attemptCount,
      last_error AS lastError,
      next_retry_at AS nextRetryAt,
      resolved_at AS resolvedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM company_profile_cache
    WHERE company_identifier = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(companyIdentifier);

  return normalizeCompanyCacheRow(row);
}

function getCompanyProfileCacheByLookupFingerprint(companyLookupFingerprint) {
  if (!companyLookupFingerprint) {
    return null;
  }

  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      id,
      company_name_raw AS companyNameRaw,
      company_name_normalized AS companyNameNormalized,
      company_lookup_fingerprint AS companyLookupFingerprint,
      company_identifier AS companyIdentifier,
      company_type AS companyType,
      company_description AS companyDescription,
      source,
      source_url AS sourceUrl,
      status,
      attempt_count AS attemptCount,
      last_error AS lastError,
      next_retry_at AS nextRetryAt,
      resolved_at AS resolvedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM company_profile_cache
    WHERE company_lookup_fingerprint = ?
    LIMIT 1
  `).get(companyLookupFingerprint);

  return normalizeCompanyCacheRow(row);
}

function getCompanyProfileCacheByNormalizedName(companyNameNormalized) {
  if (!companyNameNormalized) {
    return null;
  }

  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      id,
      company_name_raw AS companyNameRaw,
      company_name_normalized AS companyNameNormalized,
      company_lookup_fingerprint AS companyLookupFingerprint,
      company_identifier AS companyIdentifier,
      company_type AS companyType,
      company_description AS companyDescription,
      source,
      source_url AS sourceUrl,
      status,
      attempt_count AS attemptCount,
      last_error AS lastError,
      next_retry_at AS nextRetryAt,
      resolved_at AS resolvedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM company_profile_cache
    WHERE company_name_normalized = ?
    LIMIT 1
  `).get(companyNameNormalized);

  return normalizeCompanyCacheRow(row);
}

function upsertCompanyProfileCache(record) {
  const db = getDatabase();
  const existingByFingerprint = record.companyLookupFingerprint
    ? getCompanyProfileCacheByLookupFingerprint(record.companyLookupFingerprint)
    : null;
  const existingByNormalizedName = getCompanyProfileCacheByNormalizedName(record.companyNameNormalized);
  const existing = existingByFingerprint || existingByNormalizedName;

  if (existing?.id) {
    db.prepare(`
      UPDATE company_profile_cache
      SET
        company_name_raw = ?,
        company_name_normalized = ?,
        company_lookup_fingerprint = ?,
        company_identifier = COALESCE(?, company_identifier),
        company_type = ?,
        company_description = ?,
        source = ?,
        source_url = ?,
        status = ?,
        attempt_count = ?,
        last_error = ?,
        next_retry_at = ?,
        resolved_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      record.companyNameRaw || null,
      record.companyNameNormalized,
      record.companyLookupFingerprint || record.companyNameNormalized,
      record.companyIdentifier || null,
      record.companyType || null,
      record.companyDescription || null,
      record.source || null,
      record.sourceUrl || null,
      record.status,
      record.attemptCount || 0,
      record.lastError || null,
      record.nextRetryAt || null,
      record.resolvedAt || null,
      existing.id
    );
    return;
  }

  db.prepare(`
    INSERT INTO company_profile_cache (
      company_name_raw,
      company_name_normalized,
      company_lookup_fingerprint,
      company_identifier,
      company_type,
      company_description,
      source,
      source_url,
      status,
      attempt_count,
      last_error,
      next_retry_at,
      resolved_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    record.companyNameRaw || null,
    record.companyNameNormalized,
    record.companyLookupFingerprint || record.companyNameNormalized,
    record.companyIdentifier || null,
    record.companyType || null,
    record.companyDescription || null,
    record.source || null,
    record.sourceUrl || null,
    record.status,
    record.attemptCount || 0,
    record.lastError || null,
    record.nextRetryAt || null,
    record.resolvedAt || null
  );
}

function getCompanyEnrichmentStats() {
  const db = getDatabase();
  const cacheRows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM company_profile_cache
    GROUP BY status
  `).all();
  const queueRows = db.prepare(`
    SELECT enrichment_status AS status, COUNT(*) AS count
    FROM delivery_queue
    GROUP BY enrichment_status
  `).all();
  const recentFailures = db.prepare(`
    SELECT
      company_name_normalized AS companyNameNormalized,
      company_identifier AS companyIdentifier,
      last_error AS lastError,
      updated_at AS updatedAt
    FROM company_profile_cache
    WHERE last_error IS NOT NULL AND TRIM(last_error) != ''
    ORDER BY updated_at DESC
    LIMIT 10
  `).all();
  const recentSources = db.prepare(`
    SELECT
      source,
      COUNT(*) AS count
    FROM company_profile_cache
    WHERE source IS NOT NULL AND TRIM(source) != ''
    GROUP BY source
    ORDER BY count DESC, source ASC
    LIMIT 10
  `).all();

  return {
    cacheByStatus: toCountMap(cacheRows),
    queueByStatus: toCountMap(queueRows),
    recentFailures: recentFailures.map((row) => ({
      ...row,
      updatedAt: row.updatedAt ? normalizeSqliteDate(row.updatedAt) : null
    })),
    recentSources
  };
}

function markDeliveryRecordSending(id) {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE delivery_queue
    SET
      status = 'sending',
      attempt_count = attempt_count + 1,
      last_error = NULL,
      last_attempt_at = datetime('now'),
      next_retry_at = NULL,
      updated_at = datetime('now')
    WHERE id = ?
      AND status IN ('pending', 'retrying')
  `).run(id);

  return result.changes > 0;
}

function markDeliveryRecordSent(id) {
  const db = getDatabase();
  db.prepare(`
    UPDATE delivery_queue
    SET
      status = 'sent',
      last_error = NULL,
      next_retry_at = NULL,
      sent_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

function markDeliveryRecordRetry(id, lastError, nextRetryAt) {
  const db = getDatabase();
  db.prepare(`
    UPDATE delivery_queue
    SET
      status = 'retrying',
      last_error = ?,
      next_retry_at = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(lastError, nextRetryAt, id);
}

function markDeliveryRecordFailed(id, lastError) {
  const db = getDatabase();
  db.prepare(`
    UPDATE delivery_queue
    SET
      status = 'failed',
      last_error = ?,
      next_retry_at = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(lastError, id);
}

function markDeliveryRecordAbandoned(id, lastError) {
  const db = getDatabase();
  db.prepare(`
    UPDATE delivery_queue
    SET
      status = 'abandoned',
      last_error = ?,
      next_retry_at = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(lastError, id);
}

function migrateToV2(db) {
  if (!hasColumn(db, 'delivery_queue', 'delivery_target')) {
    db.exec('ALTER TABLE delivery_queue ADD COLUMN delivery_target TEXT');
  }

  const unbackfilled = db.prepare(`
    SELECT id, source_task_id AS sourceTaskId
    FROM delivery_queue
    WHERE delivery_target IS NULL
      AND source_task_id IS NOT NULL
  `).all();

  const queue = readJSON(QUEUE_FILE, []);
  const queueMap = new Map(queue.filter((task) => task?.id).map((task) => [task.id, task]));
  const updateStmt = db.prepare('UPDATE delivery_queue SET delivery_target = ? WHERE id = ?');

  let backfilled = 0;
  for (const record of unbackfilled) {
    const task = queueMap.get(record.sourceTaskId);
    if (task?.deliveryTarget) {
      updateStmt.run(task.deliveryTarget, record.id);
      backfilled += 1;
    }
  }

  console.log(`[DB] Schema v2: backfilled delivery_target for ${backfilled}/${unbackfilled.length} records`);
  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)').run(2, 'Add delivery_target column');
}

function migrateToV3(db) {
  if (!hasColumn(db, 'delivery_queue', 'enrichment_status')) {
    db.exec(`ALTER TABLE delivery_queue ADD COLUMN enrichment_status TEXT NOT NULL DEFAULT 'pending'`);
  }
  if (!hasColumn(db, 'delivery_queue', 'enrichment_updated_at')) {
    db.exec(`ALTER TABLE delivery_queue ADD COLUMN enrichment_updated_at TEXT`);
  }
  if (!hasColumn(db, 'delivery_queue', 'enrichment_deadline_at')) {
    db.exec(`ALTER TABLE delivery_queue ADD COLUMN enrichment_deadline_at TEXT`);
  }

  db.exec(`
    UPDATE delivery_queue
    SET
      enrichment_status = COALESCE(NULLIF(enrichment_status, ''), 'pending'),
      enrichment_updated_at = COALESCE(enrichment_updated_at, updated_at, created_at, datetime('now')),
      enrichment_deadline_at = COALESCE(enrichment_deadline_at, datetime(COALESCE(created_at, datetime('now')), '+5 minutes'))
    WHERE enrichment_status IS NULL
       OR enrichment_updated_at IS NULL
       OR enrichment_deadline_at IS NULL
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_delivery_enrichment_status
      ON delivery_queue (enrichment_status);
    CREATE INDEX IF NOT EXISTS idx_delivery_enrichment_deadline
      ON delivery_queue (enrichment_deadline_at)
      WHERE enrichment_status IN ('pending', 'failed');

    CREATE TABLE IF NOT EXISTS company_profile_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name_raw TEXT,
      company_name_normalized TEXT NOT NULL,
      company_identifier TEXT,
      company_type TEXT,
      company_description TEXT,
      source TEXT,
      source_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_retry_at TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_company_profile_cache_name
      ON company_profile_cache (company_name_normalized);
    CREATE INDEX IF NOT EXISTS idx_company_profile_cache_identifier
      ON company_profile_cache (company_identifier);
    CREATE INDEX IF NOT EXISTS idx_company_profile_cache_status
      ON company_profile_cache (status);
    CREATE INDEX IF NOT EXISTS idx_company_profile_cache_next_retry
      ON company_profile_cache (next_retry_at)
      WHERE status IN ('pending', 'failed');
  `);

  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)').run(3, 'Add company enrichment queue state and cache table');
}

function migrateToV4(db) {
  if (!hasColumn(db, 'company_profile_cache', 'company_lookup_fingerprint')) {
    db.exec(`ALTER TABLE company_profile_cache ADD COLUMN company_lookup_fingerprint TEXT`);
  }

  db.exec(`
    UPDATE company_profile_cache
    SET company_lookup_fingerprint = COALESCE(NULLIF(company_lookup_fingerprint, ''), company_name_normalized)
    WHERE company_lookup_fingerprint IS NULL OR company_lookup_fingerprint = ''
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_company_profile_cache_lookup_fingerprint
      ON company_profile_cache (company_lookup_fingerprint);
  `);

  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)').run(4, 'Add lookup fingerprint to company profile cache');
}

function migrateToV5(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scraped_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        platformJobId TEXT NOT NULL,
        title TEXT NOT NULL,
        company TEXT NOT NULL,
        location TEXT,
        url TEXT,
        keywords TEXT,
        salary TEXT,
        experience TEXT,
        education TEXT,
        match_status TEXT DEFAULT 'not_ready',
        selected BOOLEAN DEFAULT 0,
        crawl_batch_id TEXT,
        crawl_mode TEXT,
        job_alive_status TEXT DEFAULT 'unknown',
        raw_payload TEXT,
        crawled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(platform, platformJobId)
    );

    CREATE INDEX IF NOT EXISTS idx_scraped_jobs_status
        ON scraped_jobs(match_status, selected);
    CREATE INDEX IF NOT EXISTS idx_scraped_jobs_platform_job
        ON scraped_jobs(platform, platformJobId);
  `);

  db.pragma('incremental_vacuum');

  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
    .run(5, 'Add scraped_jobs snapshot table');
}

function migrateToV6(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      upload_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
    .run(6, 'Add resumes metadata table');
}

function migrateToV7(db) {
  if (!hasColumn(db, 'resumes', 'content_md')) {
    db.exec(`ALTER TABLE resumes ADD COLUMN content_md TEXT`);
  }
  if (!hasColumn(db, 'resumes', 'status')) {
    db.exec(`ALTER TABLE resumes ADD COLUMN status VARCHAR(20) DEFAULT 'uploaded'`);
  }

  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
    .run(7, 'Add content_md and status columns to resumes');
}

function migrateToV8(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL UNIQUE,
      api_key_encrypted TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model_name TEXT NOT NULL,
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const existingProviders = db.prepare('SELECT provider FROM ai_configs').all();
  const providerSet = new Set(existingProviders.map((r) => r.provider));

  const defaultProviders = [
    { provider: 'zhipu', base_url: 'https://open.bigmodel.cn/api/coding/paas/v4', model_name: 'glm-5' },
    { provider: 'kimi', base_url: 'https://api.moonshot.cn/v1', model_name: 'moonshot-v1-8k' },
    { provider: 'openai', base_url: 'https://api.openai.com/v1', model_name: 'gpt-4o' }
  ];

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO ai_configs (provider, api_key_encrypted, base_url, model_name, is_active)
    VALUES (?, '', ?, ?, 0)
  `);

  let inserted = 0;
  for (const p of defaultProviders) {
    if (!providerSet.has(p.provider)) {
      insertStmt.run(p.provider, p.base_url, p.model_name);
      inserted += 1;
    }
  }

  console.log(`[DB] Schema v8: created ai_configs table, inserted ${inserted} default providers`);
  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
    .run(8, 'Add ai_configs table for AI provider management');
}

function migrateToV9(db) {
  if (!hasColumn(db, 'scraped_jobs', 'is_favorite')) {
    db.exec(`ALTER TABLE scraped_jobs ADD COLUMN is_favorite INTEGER DEFAULT 0`);
  }
  // 将现有 selected=1 的记录同步为 is_favorite=1
  db.exec(`
    UPDATE scraped_jobs SET is_favorite = 1 WHERE selected = 1 AND (is_favorite IS NULL OR is_favorite = 0)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scraped_jobs_favorite
      ON scraped_jobs(is_favorite)
  `);

  console.log('[DB] Schema v9: added is_favorite column to scraped_jobs');
  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
    .run(9, 'Add is_favorite column to scraped_jobs for favorite model');
}

function migrateToV10(db) {
  // 为 ai_configs 表的 provider 字段添加 UNIQUE 约束
  // 先清理已有重复 provider 记录，保留最新一条

  const duplicates = db.prepare(`
    SELECT provider, COUNT(*) AS cnt
    FROM ai_configs
    GROUP BY provider
    HAVING cnt > 1
  `).all();

  for (const dup of duplicates) {
    // 保留每个 provider 中 id 最大的一条（最新），删除其余
    db.prepare(`
      DELETE FROM ai_configs
      WHERE provider = ? AND id NOT IN (
        SELECT id FROM ai_configs WHERE provider = ? ORDER BY id DESC LIMIT 1
      )
    `).run(dup.provider, dup.provider);
  }

  if (duplicates.length > 0) {
    console.log(`[DB] Schema v10: cleaned ${duplicates.length} duplicate providers in ai_configs`);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_configs_provider ON ai_configs(provider)
  `);

  console.log('[DB] Schema v10: added UNIQUE index on ai_configs.provider');
  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
    .run(10, 'Add UNIQUE constraint on ai_configs.provider');
}

function migrateToV11(db) {
  // 为 scraped_jobs 表新增详情采集状态机组
  if (!hasColumn(db, 'scraped_jobs', 'detail_status')) {
    db.exec(`ALTER TABLE scraped_jobs ADD COLUMN detail_status TEXT DEFAULT 'pending'`);
  }
  if (!hasColumn(db, 'scraped_jobs', 'detail_attempt_count')) {
    db.exec(`ALTER TABLE scraped_jobs ADD COLUMN detail_attempt_count INTEGER DEFAULT 0`);
  }
  if (!hasColumn(db, 'scraped_jobs', 'last_detail_attempt_at')) {
    db.exec(`ALTER TABLE scraped_jobs ADD COLUMN last_detail_attempt_at DATETIME`);
  }
  if (!hasColumn(db, 'scraped_jobs', 'next_detail_retry_at')) {
    db.exec(`ALTER TABLE scraped_jobs ADD COLUMN next_detail_retry_at DATETIME`);
  }
  if (!hasColumn(db, 'scraped_jobs', 'detail_error_code')) {
    db.exec(`ALTER TABLE scraped_jobs ADD COLUMN detail_error_code TEXT`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scraped_jobs_detail_status
      ON scraped_jobs(detail_status);
    CREATE INDEX IF NOT EXISTS idx_scraped_jobs_next_retry
      ON scraped_jobs(next_detail_retry_at);
  `);

  console.log('[DB] Schema v11: added detail_status state machine to scraped_jobs');
  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
    .run(11, 'Add detail_status state machine columns to scraped_jobs');
}

function migrateToV12(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crawl_page_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        city TEXT NOT NULL,
        keyword TEXT NOT NULL,
        page_number INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        jobs_found INTEGER DEFAULT 0,
        jobs_new INTEGER DEFAULT 0,
        started_at DATETIME,
        completed_at DATETIME,
        error TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        UNIQUE(platform, city, keyword, page_number)
    );

    CREATE INDEX IF NOT EXISTS idx_crawl_page_tasks_status
      ON crawl_page_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_crawl_page_tasks_lookup
      ON crawl_page_tasks(platform, city, keyword, status);
  `);

  // 确保 scraped_jobs 有 platform + platform_job_id 的唯一索引
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scraped_jobs_platform_job_id
      ON scraped_jobs(platform, platformJobId);
  `);

  console.log('[DB] Schema v12: created crawl_page_tasks table and ensured scraped_jobs dedup index');
  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
    .run(12, 'Add crawl_page_tasks table and scraped_jobs dedup unique index');
}

function migrateToV13(db) {
  // 为 ai_configs 添加 role 列，用于区分主模型/第二模型
  if (!hasColumn(db, 'ai_configs', 'role')) {
    db.exec(`ALTER TABLE ai_configs ADD COLUMN role TEXT NOT NULL DEFAULT 'primary'`);
  }

  // 创建深度思考全局设置表（单行存储）
  db.exec(`
    CREATE TABLE IF NOT EXISTS deep_think_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'auto',
      max_rounds INTEGER NOT NULL DEFAULT 10,
      compression_enabled INTEGER NOT NULL DEFAULT 1,
      debug INTEGER NOT NULL DEFAULT 0,
      no_new_info_rounds INTEGER NOT NULL DEFAULT 3,
      fallback_to_single INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO deep_think_settings (id) VALUES (1);
  `);

  console.log('[DB] Schema v13: added ai_configs.role column, created deep_think_settings table');
  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
    .run(13, 'Add deep_think_settings table and ai_configs.role column for secondary model');
}

function migrateToV14(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resume_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resume_id INTEGER NOT NULL,
      version_number INTEGER NOT NULL DEFAULT 1,
      md_path TEXT,
      meta_json_path TEXT,
      conversion_report_path TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      created_by TEXT DEFAULT 'system',
      FOREIGN KEY (resume_id) REFERENCES resumes(id)
    );

    CREATE INDEX IF NOT EXISTS idx_resume_versions_resume_id ON resume_versions(resume_id);
  `);

  console.log('[DB] Schema v14: created resume_versions table');
  db.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)')
    .run(14, 'Add resume_versions table for resume pipeline artifacts');
}

function hasColumn(db, tableName, columnName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => column.name === columnName);
}

function readJSON(file, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeStatuses(status) {
  if (!status) {
    return ['pending', 'retrying'];
  }

  const parts = String(status)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return ['pending', 'retrying'];
  }

  return [...new Set(parts)];
}

function normalizePositiveInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  if (parsed < min) {
    return min;
  }
  if (parsed > max) {
    return max;
  }
  return parsed;
}

function normalizeSqliteDate(value) {
  if (!value) {
    return null;
  }
  if (value.endsWith('Z')) {
    return value;
  }
  return `${String(value).replace(' ', 'T')}Z`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function cleanPayloadString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function derivePayloadEnrichmentStatus(payload, fallbackStatus = 'pending') {
  const hasType = Boolean(cleanPayloadString(payload?.['公司类型']));
  const hasDescription = Boolean(cleanPayloadString(payload?.['公司简介']));
  if (hasType && hasDescription) {
    return 'resolved';
  }
  if (hasType || hasDescription) {
    return 'partial';
  }
  return fallbackStatus;
}

function normalizeCompanyCacheRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    nextRetryAt: row.nextRetryAt ? normalizeSqliteDate(row.nextRetryAt) : null,
    resolvedAt: row.resolvedAt ? normalizeSqliteDate(row.resolvedAt) : null,
    createdAt: row.createdAt ? normalizeSqliteDate(row.createdAt) : null,
    updatedAt: row.updatedAt ? normalizeSqliteDate(row.updatedAt) : null
  };
}

function toCountMap(rows) {
  const counts = {};
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

// ============ crawl_page_tasks CRUD ============

/**
 * 创建页码任务记录（如果已存在则忽略）
 *
 * @param {string} platform - 平台标识
 * @param {string} city - 城市名
 * @param {string} keyword - 搜索关键词
 * @param {number} [pageNumber=1] - 页码
 * @returns {{ id: number|null, created: boolean }}
 */
function createPageTask(platform, city, keyword, pageNumber = 1) {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT OR IGNORE INTO crawl_page_tasks (platform, city, keyword, page_number, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(platform, city, keyword, pageNumber);

  if (result.changes === 0) {
    return { id: null, created: false };
  }
  return { id: result.lastInsertRowid, created: true };
}

/**
 * 更新页码任务状态
 *
 * @param {number} id - 任务 ID
 * @param {'pending'|'running'|'done'|'failed'} status - 目标状态
 * @param {Object} [options] - 可选附加字段
 * @param {number} [options.jobsFound] - 发现的职位数
 * @param {number} [options.jobsNew] - 新增的职位数
 * @param {string} [options.error] - 错误信息
 * @returns {boolean} 是否更新成功
 */
function updatePageTaskStatus(id, status, options = {}) {
  const db = getDatabase();

  const fields = ['status = ?'];
  const params = [status];

  if (status === 'running') {
    fields.push("started_at = datetime('now', 'localtime')");
  }
  if (status === 'done' || status === 'failed') {
    fields.push("completed_at = datetime('now', 'localtime')");
  }
  if (options.jobsFound !== undefined) {
    fields.push('jobs_found = ?');
    params.push(options.jobsFound);
  }
  if (options.jobsNew !== undefined) {
    fields.push('jobs_new = ?');
    params.push(options.jobsNew);
  }
  if (options.error !== undefined) {
    fields.push('error = ?');
    params.push(options.error);
  }

  params.push(id);
  const result = db.prepare(`
    UPDATE crawl_page_tasks SET ${fields.join(', ')} WHERE id = ?
  `).run(...params);

  return result.changes > 0;
}

/**
 * 查询待执行的页码任务
 *
 * @param {string} [platform] - 平台过滤
 * @param {string} [city] - 城市过滤
 * @param {string} [keyword] - 关键词过滤
 * @param {number} [limit=100] - 返回条数上限
 * @returns {Array<Object>} 待执行的页码任务列表
 */
function getPendingPageTasks(platform, city, keyword, limit = 100) {
  const db = getDatabase();
  const conditions = ["status = 'pending'"];
  const params = [];

  if (platform) {
    conditions.push('platform = ?');
    params.push(platform);
  }
  if (city) {
    conditions.push('city = ?');
    params.push(city);
  }
  if (keyword) {
    conditions.push('keyword = ?');
    params.push(keyword);
  }

  params.push(limit);
  return db.prepare(`
    SELECT * FROM crawl_page_tasks
    WHERE ${conditions.join(' AND ')}
    ORDER BY page_number ASC, id ASC
    LIMIT ?
  `).all(...params);
}

/**
 * 断点恢复：将所有 status='running' 的页码任务重置为 'pending'
 *
 * @returns {number} 重置的任务数量
 */
function resetRunningPageTasks() {
  const db = getDatabase();
  const result = db.prepare(`
    UPDATE crawl_page_tasks
    SET status = 'pending', started_at = NULL, error = 'reset_on_recovery'
    WHERE status = 'running'
  `).run();

  if (result.changes > 0) {
    console.log(`[DB] resetRunningPageTasks: ${result.changes} running tasks reset to pending`);
  }
  return result.changes;
}

// --- 深度思考设置 CRUD ---
function getDeepThinkSettings() {
  const db = getDatabase();
  return db.prepare('SELECT * FROM deep_think_settings WHERE id = 1').get() || null;
}

function updateDeepThinkSettings(settings) {
  const db = getDatabase();
  const allowed = ['enabled', 'mode', 'max_rounds', 'compression_enabled', 'debug', 'no_new_info_rounds', 'fallback_to_single'];
  const sets = [];
  const vals = [];

  for (const key of allowed) {
    if (settings[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(typeof settings[key] === 'boolean' ? (settings[key] ? 1 : 0) : settings[key]);
    }
  }

  if (sets.length === 0) return false;
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE deep_think_settings SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
  return true;
}

// --- 第二模型配置 ---
function getSecondaryModelConfig() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM ai_configs WHERE role = 'secondary' LIMIT 1").get() || null;
}

function upsertSecondaryModelConfig({ provider, apiKeyEncrypted, baseUrl, modelName }) {
  const db = getDatabase();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const existing = db.prepare("SELECT id FROM ai_configs WHERE role = 'secondary'").get();

  if (existing) {
    db.prepare(`
      UPDATE ai_configs
      SET provider = ?, api_key_encrypted = ?, base_url = ?, model_name = ?, updated_at = ?
      WHERE id = ?
    `).run(provider, apiKeyEncrypted, baseUrl || '', modelName || '', now, existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO ai_configs (provider, api_key_encrypted, base_url, model_name, is_active, role, updated_at)
    VALUES (?, ?, ?, ?, 0, 'secondary', ?)
  `).run(provider, apiKeyEncrypted, baseUrl || '', modelName || '', now);
  return result.lastInsertRowid;
}

function deleteSecondaryModelConfig() {
  const db = getDatabase();
  return db.prepare("DELETE FROM ai_configs WHERE role = 'secondary'").run().changes;
}

module.exports = {
  DEFAULT_DB_PATH,
  SCHEMA_VERSION,
  initDatabase,
  getDatabase,
  insertDeliveryRecord,
  getPendingEnrichmentRecords,
  updateDeliveryRecordEnrichment,
  markDeliveryRecordEnrichmentStatus,
  updateDeliveryPayloadCompanyFieldsByNormalizedName,
  getCompanyProfileCacheByLookupFingerprint,
  getPendingDeliveryRecords,
  markDeliveryRecordSending,
  markDeliveryRecordSent,
  markDeliveryRecordRetry,
  markDeliveryRecordFailed,
  markDeliveryRecordAbandoned,
  getCompanyProfileCacheByIdentifier,
  getCompanyProfileCacheByNormalizedName,
  upsertCompanyProfileCache,
  getCompanyEnrichmentStats,
  getDeliveryStats,
  getDeliveryRecords,
  closeDatabase,
  // crawl_page_tasks
  createPageTask,
  updatePageTaskStatus,
  getPendingPageTasks,
  resetRunningPageTasks,
  // deep-think
  getDeepThinkSettings,
  updateDeepThinkSettings,
  getSecondaryModelConfig,
  upsertSecondaryModelConfig,
  deleteSecondaryModelConfig
};
