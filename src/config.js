/**
 * 配置：默认值 + 文件加载 + 校验（手写，不引依赖）
 */

export const DEFAULTS = {
  qq: {
    ownerQQ: 0,
    selfQQ: 0,
    snowluma: { url: 'ws://127.0.0.1:3001', token: '', homeDir: '' },
    botNames: [],
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
    consolidateAt: '04:30',
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
    // 二代模式：模型文本一律不转发，只认发送工具（v1 的规矩）
    autoForward: false,
    minGapMs: 600,
    maxGapMs: 1800,
    maxPerMinute: 10,
    splitThreshold: 60,
    imagesPerMinute: 2,
    stickersPerMinute: 2,
    voicesPerMinute: 2,
    pokesPerMinute: 3,
  },
  console: { port: 3100, token: '' },
  storagePath: '',
  retain: { messagesDays: 90 },
  wake: {
    privateAlways: true,
    triggers: { at: true, name: true, question: true, anyMessage: false, probabilityGroup: 0.05 },
  },
  social: {
    enabled: true,
    proactiveEnabled: true,
    idleThresholdMs: 30 * 60 * 1000,
    checkMinMs: 45 * 60 * 1000,
    checkMaxMs: 90 * 60 * 1000,
    probability: 0.2,
    probeAfterIdleMs: 3 * 60 * 1000,
    probeProbability: 0.25,
    probeWaitMs: 2 * 60 * 1000,
    qzone: { enabled: true, perDay: 3, windowStartHour: 21, windowEndHour: 23, cooldownMs: 6 * 3600 * 1000, probability: 0.3 },
  },
  rotate: {
    // 会话轮转：消息数或文件大小任一超限就归档旧会话、开新代次
    enabled: true,
    groupMessages: 800,
    privateMessages: 1500,
    maxBytes: 8 * 1024 * 1024,
    summaryPrompt: '把上面这段对话总结成不超过 8 条要点：主题、结论、未完成的事。只输出要点，不要寒暄。',
  },
  media: {
    // 收图缓存（state/media）保留天数；每天 prune-media 清理过期文件
    retainDays: 30,
    pruneAt: '04:50',
  },
  speech: {
    // none / sherpa（本地 SenseVoice）/ http（OpenAI 兼容接口）
    provider: 'none',
    voicesDir: './audio',
    modelDir: '',
    numThreads: 2,
    language: 'zh',
    http: { url: '', apiKey: '', model: 'whisper-1' },
  },
  security: { sensitivePatterns: ['sk-', 'token', '密码'] },
  log: { level: 'info', dir: './state/logs', keepDays: 7, pruneAt: '04:40' },
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

  const validSpeech = ['sherpa', 'http', 'none'];
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
