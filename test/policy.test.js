import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sessionAllowed, toolScopeFor, toolAllowed, isOwnerSession, actionAllowed } from '../src/security/policy.js';

const cfg = (over = {}) => ({
  qq: { ownerQQ: 100, selfQQ: 200 },
  allow: { private: [1, 2], groups: [456], emptyGroupsMeansAll: false },
  ...over,
});

test('会话准入：私聊白名单', () => {
  assert.equal(sessionAllowed('private:1', cfg()), true);
  assert.equal(sessionAllowed('private:9', cfg()), false);
});

test('会话准入：群白名单', () => {
  assert.equal(sessionAllowed('group:456', cfg()), true);
  assert.equal(sessionAllowed('group:999', cfg()), false);
});

test('会话准入：群名单为空时按 emptyGroupsMeansAll', () => {
  const open = cfg({ allow: { private: [], groups: [], emptyGroupsMeansAll: true } });
  const closed = cfg({ allow: { private: [], groups: [], emptyGroupsMeansAll: false } });
  assert.equal(sessionAllowed('group:999', open), true);
  assert.equal(sessionAllowed('group:999', closed), false);
});

test('非法 key 一律拒绝', () => {
  assert.equal(sessionAllowed('', cfg()), false);
  assert.equal(sessionAllowed('guild:1', cfg()), false);
});

test('工具作用域：owner / allowlist / group', () => {
  assert.equal(toolScopeFor('private:100', cfg()), 'owner');
  assert.equal(toolScopeFor('private:1', cfg()), 'allowlist');
  assert.equal(toolScopeFor('group:456', cfg()), 'group');
});

test('工具准入矩阵', () => {
  const tool = (scope) => ({ name: 'x', scope });
  assert.equal(toolAllowed(tool('all'), 'group'), true);
  assert.equal(toolAllowed(tool('group'), 'group'), true);
  assert.equal(toolAllowed(tool('allowlist'), 'group'), false);
  assert.equal(toolAllowed(tool('allowlist'), 'allowlist'), true);
  assert.equal(toolAllowed(tool('allowlist'), 'owner'), true);
  assert.equal(toolAllowed(tool('owner'), 'allowlist'), false);
  assert.equal(toolAllowed(tool('owner'), 'owner'), true);
});

test('isOwnerSession 只认 owner 私聊', () => {
  assert.equal(isOwnerSession('private:100', cfg()), true);
  assert.equal(isOwnerSession('private:1', cfg()), false);
  assert.equal(isOwnerSession('group:100', cfg()), false);
});

test('动作准入：传话/说说/手机/配置仅 owner', () => {
  for (const action of ['relay', 'post', 'phone', 'config']) {
    assert.equal(actionAllowed(action, 'private:100', cfg()), true, action);
    assert.equal(actionAllowed(action, 'private:1', cfg()), false, action);
    assert.equal(actionAllowed(action, 'group:456', cfg()), false, action);
  }
  assert.equal(actionAllowed('chat', 'group:456', cfg()), true);
});
