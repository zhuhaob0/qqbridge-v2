#!/usr/bin/env node
/**
 * 入口：装配并启动
 *
 *   node src/index.js [--config ./config.json] [--dry-run] [--no-console]
 */

import fs from 'node:fs';
import path from 'node:path';

import { requireConfig, ConfigError } from './config.js';
import { openDatabase } from './storage/db.js';
import * as q from './storage/queries.js';
import { createLogger } from './util/logger.js';
import { acquireLock } from './util/lock.js';
import { createMemoryClient } from './memory/client.js';
import { createApp } from './app.js';
import { createConsoleServer } from './console/server.js';
import { createDryRunQq } from './qq/dry-run.js';
import { createBus } from './router/bus.js';
import { createToolRegistry } from './tools/index.js';
import { createScheduler } from './scheduler/scheduler.js';
import { pruneMedia } from './storage/media.js';
import { createSpeech } from './speech/index.js';

function parseArgs(argv) {
  const flags = { dryRun: false, console: true, config: './config.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') flags.config = argv[++i];
    else if (argv[i] === '--dry-run') flags.dryRun = true;
    else if (argv[i] === '--no-console') flags.console = false;
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));

let loaded = {};
if (fs.existsSync(flags.config)) {
  loaded = JSON.parse(fs.readFileSync(flags.config, 'utf8'));
}

let config;
try {
  const result = requireConfig(loaded);
  config = result.config;
  for (const warning of result.warnings) console.warn(`[config] ${warning}`);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

// DSH 冷启动时端口会变：由守护进程通过 DSH_BASE_URL 注入最新地址
const envDshBase = process.env.DSH_BASE_URL;
if (envDshBase) config.agent = { ...(config.agent ?? {}), baseUrl: envDshBase };

const logger = createLogger({ level: config.log?.level ?? 'info', dir: config.log?.dir ?? '' });

const lock = acquireLock(path.resolve('./state/bridge.lock'));
if (!lock.ok) {
  logger.error(lock.reason ?? '无法获取实例锁');
  process.exit(1);
}

const db = openDatabase(config.storagePath ?? './state/qqbridge.db');
const memory = config.memory?.enabled
  ? createMemoryClient({
    baseUrl: config.memory.baseUrl,
    token: config.memory.token,
    tenant: config.memory.tenant,
    timeoutMs: config.memory.timeoutMs,
    shareScope: config.memory.shareScope,
    logger,
  })
  : null;

const agent = await (async () => {
  if (flags.dryRun) {
    const { createFakeAgent } = await import('./agent/fake.js');
    return createFakeAgent({ replies: ['（dry-run）'] });
  }
  const { createDshAgentFromConfig } = await import('./agent/dsh.js');
  return createDshAgentFromConfig(config, { logger });
})();

const qq = flags.dryRun ? createDryRunQq({ logger }) : null;

let transport = null;
if (!qq) {
  const { createSnowLumaTransportFromConfig } = await import('./transport/snowluma.js');
  transport = await createSnowLumaTransportFromConfig(config, { logger, onRaw: (raw) => app.router.handle(raw) });
}

const bus = createBus();
const registry = createToolRegistry();

const app = createApp({
  db,
  config,
  agent,
  qq: qq ?? transport,
  memory,
  logger,
  bus,
});

transport?.start();

const speech = createSpeech(config.speech ?? {});

const scheduler = createScheduler({
  logger,
  jobs: [
    {
      name: 'consolidate',
      at: config.memory?.consolidateAt ?? '04:30',
      run: async () => (memory ? memory.consolidate() : null),
    },
    {
      name: 'prune-media',
      at: config.media?.pruneAt ?? '04:50',
      run: async () => pruneMedia({ days: config.media?.retainDays ?? 30 }),
    },
    {
      name: 'prune',
      at: config.log?.pruneAt ?? '04:40',
      run: async () => {
        const now = Date.now();
        const days = (n) => new Date(now - n * 86400000).toISOString();
        const messages = q.pruneMessages(db, days(config.retain?.messagesDays ?? 90));
        const dedupe = q.pruneDedupe(db, days(7));
        const rates = q.pruneRateLimits(db, days(2).slice(0, 16));
        return { messages, dedupe, rates };
      },
    },
  ],
});
scheduler.start();

let consoleServer = null;
if (flags.console) {
  consoleServer = createConsoleServer({
    db,
    config,
    transport,
    memory,
    logger,
    registry,
    toolCtx: { db, config, qq: qq ?? transport, memory, bus, logger },
    stats: () => ({
      messages: Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n ?? 0),
      sessions: Number(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n ?? 0),
    }),
    getSessions: () => q.listSessions(db, 50),
  });
  const addr = await consoleServer.listen();
  logger.info('控制台已启动', { url: `http://127.0.0.1:${addr.port}/console` });
}

logger.info('qqbridge-v2 已启动', {
  owner: config.qq.ownerQQ,
  self: config.qq.selfQQ,
  dryRun: flags.dryRun,
  memory: Boolean(memory),
  speech: speech.provider,
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('正在退出', { signal });
  try {
    scheduler.stop();
    transport?.stop();
    await agent?.close?.();
    await consoleServer?.close?.();
    db.close();
  } finally {
    lock.release();
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
