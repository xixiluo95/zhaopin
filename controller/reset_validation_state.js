#!/usr/bin/env node

const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'zhaopin.db');

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    dryRun: argv.includes('--dry-run') || !argv.includes('--apply'),
    dbPath: process.env.ZHAOPIN_DB_PATH || DEFAULT_DB_PATH
  };
}

function countDeliveryQueue(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM delivery_queue').get().count;
}

function main() {
  const args = parseArgs(process.argv);
  const db = new Database(args.dbPath);

  try {
    const beforeCount = countDeliveryQueue(db);
    const summary = {
      mode: args.apply ? 'apply' : 'dry-run',
      dbPath: args.dbPath,
      deliveryQueueCountBefore: beforeCount,
      extensionSeenJobIds: 'manual-clear-required-via-extension-message'
    };

    if (!args.apply) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    db.prepare('DELETE FROM delivery_queue').run();
    const afterCount = countDeliveryQueue(db);

    console.log(JSON.stringify({
      ...summary,
      deliveryQueueCountAfter: afterCount
    }, null, 2));
  } finally {
    db.close();
  }
}

main();
