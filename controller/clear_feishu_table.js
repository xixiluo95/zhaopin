#!/usr/bin/env node

const {
  getTenantAccessToken,
  getTargetConfig,
  listTargets
} = require('./feishu-client');

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const PAGE_SIZE = 500;
const DELETE_BATCH_SIZE = 100;

function parseArgs(argv) {
  const args = {
    target: null,
    apply: false,
    dryRun: false
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') {
      args.target = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
    }
  }

  if (!args.apply) {
    args.dryRun = true;
  }

  return args;
}

async function listAllRecords(targetName) {
  const targetConfig = getTargetConfig(targetName);
  if (!targetConfig) {
    const knownTargets = listTargets().map((item) => item.name).join(', ');
    throw new Error(`Unknown delivery target: ${targetName}. Known targets: ${knownTargets}`);
  }

  const token = await getTenantAccessToken(targetName);
  const records = [];
  let pageToken = '';

  while (true) {
    const url = new URL(`${FEISHU_API_BASE}/bitable/v1/apps/${targetConfig.appToken}/tables/${targetConfig.tableId}/records`);
    url.searchParams.set('page_size', String(PAGE_SIZE));
    if (pageToken) {
      url.searchParams.set('page_token', pageToken);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const data = await response.json();

    if (!response.ok || data.code !== 0) {
      throw new Error(data.msg || data.message || `Failed to list records for ${targetName}`);
    }

    const items = Array.isArray(data.data?.items) ? data.data.items : [];
    records.push(...items);

    if (!data.data?.has_more) {
      break;
    }
    pageToken = data.data.page_token || '';
  }

  return { token, records, targetConfig };
}

async function batchDelete(targetConfig, token, recordIds) {
  const response = await fetch(
    `${FEISHU_API_BASE}/bitable/v1/apps/${targetConfig.appToken}/tables/${targetConfig.tableId}/records/batch_delete`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ records: recordIds })
    }
  );
  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || data.message || `Failed to delete ${recordIds.length} records`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.target) {
    throw new Error('Usage: node controller/clear_feishu_table.js --target <name> [--dry-run|--apply]');
  }

  const { token, records, targetConfig } = await listAllRecords(args.target);
  const summary = {
    mode: args.apply ? 'apply' : 'dry-run',
    target: args.target,
    totalRecords: records.length,
    sampleRecordIds: records.slice(0, 10).map((item) => item.record_id)
  };

  if (!args.apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  let deleted = 0;
  for (let index = 0; index < records.length; index += DELETE_BATCH_SIZE) {
    const recordIds = records.slice(index, index + DELETE_BATCH_SIZE).map((item) => item.record_id);
    if (recordIds.length === 0) {
      continue;
    }
    await batchDelete(targetConfig, token, recordIds);
    deleted += recordIds.length;
  }

  console.log(JSON.stringify({
    ...summary,
    deleted,
    remainingExpected: 0
  }, null, 2));
}

main().catch((error) => {
  console.error(`[clear_feishu_table] ${error.message}`);
  process.exit(1);
});
