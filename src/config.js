/**
 * 配置：默认值 + 文件加载 + 校验（手写，不引依赖）
 */

export const DEFAULTS = {
  qq: {
    ownerQQ: 0,
    selfQQ: 0,
    snowluma: { url: 'ws://127.0.0.1:3001', token: '' },
  },
  allow: {
    private: [],
    groups: [],
    emptyGroupsMeansAll: true,
  },
  memory: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:8321',
    token: '',
    tenant: 'default',
    timeoutMs: 800,
  },
  agent: {
    kind: 'dsh',
    baseUrl: '',
    preset: 'qq-chat-v2',
    sessionCwd: './sessions',
  },
  wake: {
    batchWindowMs: 1500,
    sleepObservationMs: 300000,
    triggers: { at: true, name: true, question: true, probability: 0.15 },
  },
  send: {
    minGapMs: 600,
    maxGapMs: 1800,
    maxPerMinute: 10,
    splitThreshold: 60,
  },
  console: { port: 3100, token: '' },
  speech: {
    provider: 'none',
    sensevoice: { model: '', threads: 2 },
    http: { url: '', apiKey: '', model: 'whisper-1' },
  },
  security: { sensitivePatterns: ['sk-', 'token', '密码'] },
  log: { level: 'info', dir: './state/logs', keepDays: 7 },
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  if (!isObject(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

const KNOWN_TOP = new Set(Object.keys(DEFAULTS));

/**
 * 校验配置，返回 { errors, warnings }
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  const owner = Number(config?.qq?.ownerQQ);
  if (!Number.isInteger(owner) || owner <= 0) errors.push('qq.ownerQQ 必须是正整数');

  const self = Number(config?.qq?.selfQQ);
  if (!Number.isInteger(self) || self <= 0) errors.push('qq.selfQQ 必须是正整数');
  if (owner && self && owner === self) errors.push('qq.ownerQQ 与 qq.selfQQ 不能相同');

  if (!Array.isArray(config?.allow?.private)) errors.push('allow.private 必须是数组');
  if (!Array.isArray(config?.allow?.groups)) errors.push('allow.groups 必须是数组');

  if (Array.isArray(config?.allow?.groups) && config.allow.groups.length === 0) {
    if (typeof config?.allow?.emptyGroupsMeansAll !== 'boolean') {
      errors.push('allow.groups 为空时必须显式声明 emptyGroupsMeansAll');
    }
  }

  if (config?.memory?.enabled !== false) {
    try {
      new URL(String(config?.memory?.baseUrl ?? ''));
    } catch {
      errors.push('memory.baseUrl 不是合法 URL');
    }
  }

  const { minGapMs, maxGapMs } = config?.send ?? {};
  if (Number(minGapMs) > Number(maxGapMs)) errors.push('send.minGapMs 不能大于 send.maxGapMs');
  if (Number(maxGapMs) > 10000) warnings.push('send.maxGapMs 过大，可能显得不自然');

  const validSpeech = ['sensevoice', 'whisper', 'http', 'none'];
  if (!validSpeech.includes(config?.speech?.provider)) {
    errors.push(`speech.provider 必须是 ${validSpeech.join(' / ')}`);
  }

  for (const key of Object.keys(config ?? {})) {
    if (!KNOWN_TOP.has(key)) warnings.push(`未知配置项：${key}`);
  }

  return { errors, warnings };
}

export function loadConfig(raw = {}) {
  const merged = deepMerge(DEFAULTS, raw);
  const { errors, warnings } = validateConfig(merged);
  return { config: merged, errors, warnings };
}

export class ConfigError extends Error {
  constructor(errors) {
    super(`配置不合法：\n  - ${errors.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

/** 加载并断言，失败抛 ConfigError（启动时用） */
export function requireConfig(raw = {}) {
  const { config, errors, warnings } = loadConfig(raw);
  if (errors.length > 0) throw new ConfigError(errors);
  return { config, warnings };
}
