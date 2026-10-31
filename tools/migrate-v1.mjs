#!/usr/bin/env node
/**
 * v1 → v2 迁移 CLI
 *
 *   node tools/migrate-v1.mjs --v1 D:/Software/QQBot/qq-bridge --db ./state/qqbridge.db \
 *     [--memory http://127.0.0.1:8321] [--token xxx] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';

import { openDatabase } from '../src/storage/db.js';
import { createMemoryClient } from '../src/memory/client.js';
import { migrateV1, mapConfig } from '../src/migration/v1.js';

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--v1') out.v1 = argv[++i];
    else if (arg === '--db') out.db = argv[++i];
    else if (arg === '--memory') out.memory = argv[++i];
    else if (arg === '--token') out.token = argv[++i];
    else if (arg === '--write-config') out.writeConfig = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.v1 || !args.db) {
  console.error('用法: node tools/migrate-v1.mjs --v1 <v1目录> --db <v2数据库> [--memory URL] [--dry-run]');
  process.exit(1);
}

const logger = {
  info: (msg, fields) => console.log(`[migrate] ${msg}`, fields ? JSON.stringify(fields) : ''),
  warn: (msg, fields) => console.warn(`[migrate] ${msg}`, fields ? JSON.stringify(fields) : ''),
};

const db = openDatabase(args.db);
const memory = args.memory
  ? createMemoryClient({ baseUrl: args.memory, token: args.token ?? '', logger })
  : null;

const report = await migrateV1({ v1Dir: args.v1, db, memory, dryRun: args.dryRun, logger });

if (args.writeConfig) {
  const v1Config = JSON.parse(fs.readFileSync(path.join(args.v1, 'config.json'), 'utf8'));
  const v2Config = mapConfig(v1Config);
  fs.writeFileSync(args.writeConfig, `${JSON.stringify(v2Config, null, 2)}\n`, 'utf8');
  console.log(`[migrate] 已写出 v2 配置：${args.writeConfig}`);
}

console.log(JSON.stringify(report, null, 2));
db.close();
