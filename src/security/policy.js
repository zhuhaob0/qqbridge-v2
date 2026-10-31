/**
 * 权限：纯函数，便于单测与审计
 *
 * 三层：会话准入 → 工具准入 → 动作准入
 */

import { parseSessionKey } from '../router/session.js';

export function isOwnerSession(key, config) {
  const parsed = parseSessionKey(key);
  return Boolean(parsed) && parsed.kind === 'direct'
    && String(parsed.id) === String(config?.qq?.ownerQQ ?? '');
}

/** ① 会话准入 */
export function sessionAllowed(key, config) {
  const parsed = parseSessionKey(key);
  if (!parsed) return false;

  if (parsed.kind === 'direct') {
    const list = (config?.allow?.private ?? []).map(String);
    return list.includes(String(parsed.id));
  }

  const groups = (config?.allow?.groups ?? []).map(String);
  if (groups.length === 0) return config?.allow?.emptyGroupsMeansAll === true;
  return groups.includes(String(parsed.id));
}

/** ② 工具准入：返回该会话的作用域 */
export function toolScopeFor(key, config) {
  const parsed = parseSessionKey(key);
  if (!parsed) return 'none';
  if (parsed.kind === 'direct') {
    return String(parsed.id) === String(config?.qq?.ownerQQ ?? '') ? 'owner' : 'allowlist';
  }
  return 'group';
}

const SCOPE_RANK = { none: 0, group: 1, allowlist: 2, owner: 3 };

/** 工具声明的 scope 与当前会话 scope 是否匹配 */
export function toolAllowed(tool, scope) {
  const need = tool?.scope ?? 'all';
  if (need === 'all') return true;
  if (need === 'owner') return scope === 'owner';
  if (need === 'allowlist') return SCOPE_RANK[scope] >= SCOPE_RANK.allowlist;
  if (need === 'group') return SCOPE_RANK[scope] >= SCOPE_RANK.group;
  return false;
}

/** ③ 动作准入：显式列出的动作只允许 owner */
export const OWNER_ONLY_ACTIONS = new Set(['relay', 'post', 'phone', 'config', 'forget-any']);

export function actionAllowed(action, key, config) {
  if (!OWNER_ONLY_ACTIONS.has(action)) return true;
  return isOwnerSession(key, config);
}
