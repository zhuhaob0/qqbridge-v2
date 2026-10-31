import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEvent, isSelfMessage } from '../src/transport/normalize.js';

const privateEvent = (over = {}) => ({
  post_type: 'message',
  message_type: 'private',
  time: 1730300000,
  self_id: 200,
  user_id: 1,
  message_id: 1001,
  message: [{ type: 'text', data: { text: '你好' } }],
  sender: { user_id: 1, nickname: '小明' },
  ...over,
});

test('私聊文本', () => {
  const msg = normalizeEvent(privateEvent(), { selfQQ: 200 });
  assert.equal(msg.sessionKey, 'private:1');
  assert.equal(msg.kind, 'direct');
  assert.equal(msg.text, '你好');
  assert.equal(msg.direction, 'inbound');
  assert.equal(msg.senderName, '小明');
  assert.equal(msg.hasMedia, false);
});

test('群聊 @ 与图片会被标记', () => {
  const raw = {
    post_type: 'message',
    message_type: 'group',
    group_id: 456,
    user_id: 1,
    message_id: 1002,
    message: [
      { type: 'at', data: { qq: '200' } },
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: { file: 'a.jpg' } },
    ],
    sender: { user_id: 1, card: '群名片' },
  };
  const msg = normalizeEvent(raw, { selfQQ: 200 });
  assert.equal(msg.sessionKey, 'group:456');
  assert.equal(msg.kind, 'public');
  assert.match(msg.text, /@200/);
  assert.match(msg.text, /\[图片\]/);
  assert.equal(msg.hasMedia, true);
  assert.equal(msg.media[0].type, 'image');
});

test('自己发的消息标记为 outbound', () => {
  const msg = normalizeEvent(privateEvent({ user_id: 200, sender: { user_id: 200 } }), { selfQQ: 200 });
  assert.equal(msg.direction, 'outbound');
  assert.equal(isSelfMessage(msg, 200), true);
});

test('非消息事件返回 null', () => {
  assert.equal(normalizeEvent({ post_type: 'notice' }, {}), null);
  assert.equal(normalizeEvent({ post_type: 'message', message_type: 'guild' }, {}), null);
  assert.equal(normalizeEvent(null, {}), null);
});

test('缺少 id 时返回 null', () => {
  assert.equal(normalizeEvent({ post_type: 'message', message_type: 'private', user_id: 0 }, {}), null);
});

test('字符串消息体也能处理', () => {
  const raw = privateEvent({ message: '纯文本' });
  const msg = normalizeEvent(raw, { selfQQ: 200 });
  assert.equal(msg.text, '纯文本');
});

test('时间戳转 ISO', () => {
  const msg = normalizeEvent(privateEvent({ time: 1730300000 }), { selfQQ: 200 });
  assert.match(msg.at, /^2024-10-30T/);
});
