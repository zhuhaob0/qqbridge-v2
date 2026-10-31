/**
 * 工具注册表：定义、按作用域过滤、鉴权调用
 */

import { toolAllowed, toolScopeFor, sessionAllowed } from '../security/policy.js';
import { getSession } from '../storage/queries.js';

export class ToolError extends Error {
  constructor(message, code = 'tool_error') {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

export function createRegistry() {
  const tools = new Map();

  function register(def) {
    if (!def?.name || typeof def.run !== 'function') {
      throw new TypeError('工具定义需要 name 与 run');
    }
    tools.set(def.name, {
      name: def.name,
      description: def.description ?? '',
      inputSchema: def.inputSchema ?? { type: 'object', properties: {} },
      scope: def.scope ?? 'all',
      run: def.run,
    });
    return registry;
  }

  function list(scope = null) {
    const all = [...tools.values()];
    if (!scope) return all;
    return all.filter((t) => toolAllowed(t, scope));
  }

  function get(name) {
    return tools.get(name) ?? null;
  }

  /** 鉴权：会话存在、令牌匹配、会话在白名单内 */
  function authenticate(db, config, key, token) {
    if (!key) throw new ToolError('缺少会话 key', 'no_key');
    if (!sessionAllowed(key, config)) throw new ToolError('会话不在白名单', 'forbidden');
    const session = getSession(db, key);
    if (!session) throw new ToolError('会话不存在', 'no_session');
    if (!session.agentToken || session.agentToken !== token) {
      throw new ToolError('会话令牌无效', 'bad_token');
    }
    return session;
  }

  const registry = {
    register,
    list,
    get,
    size: () => tools.size,
    authenticate,

    async call(name, args = {}, ctx = {}) {
      const tool = tools.get(name);
      if (!tool) throw new ToolError(`未知工具：${name}`, 'unknown_tool');

      const { db, config } = ctx;
      const session = authenticate(db, config, args.key, args.token);
      const scope = toolScopeFor(args.key, config);
      if (!toolAllowed(tool, scope)) {
        throw new ToolError(`当前会话无权使用 ${name}`, 'forbidden');
      }

      return tool.run({ ...ctx, session, sessionKey: args.key, scope }, args);
    },
  };

  return registry;
}
