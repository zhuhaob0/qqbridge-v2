import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSnowLumaTransport } from '../src/transport/snowluma.js';
import { createDryRunQq } from '../src/qq/dry-run.js';

function fakeClient() {
  const calls = { private: [], group: [], connects: 0, closes: 0 };
  const handlers = { private: null, group: null, notice: null };
  return {
    calls,
    handlers,
    onPrivateMessage(cb) { handlers.private = cb; },
    onGroupMessage(cb) { handlers.group = cb; },
    onNotice(_type, cb) { handlers.notice = cb; },
    connect() { calls.connects += 1; },
    close() { calls.closes += 1; },
    async sendPrivateMessage(id, payload) {
      calls.private.push({ id, payload });
      return { message_id: 100 + calls.private.length };
    },
    async sendGroupMessage(id, payload) {
      calls.group.push({ id, payload });
      return { data: { message_id: 200 + calls.group.length } };
    },
  };
}

test('传输层：私聊/群聊事件转发给 router', () => {
  const client = fakeClient();
  const raw = [];
  const t = createSnowLumaTransport({ client, onRaw: (e) => raw.push(e) });
  client.handlers.private({ user_id: 1, post_type: 'message' });
  client.handlers.group({ group_id: 2, post_type: 'message' });
  client.handlers.notice({ sub_type: 'poke' });
  assert.equal(raw.length, 3);
  assert.equal(raw[2].post_type, 'notice');
  t.stop();
});

test('传输层：sendText 映射到正确的方法', async () => {
  const client = fakeClient();
  const t = createSnowLumaTransport({ client, builder: { text: (s) => ({ type: 'text', data: { text: s } }) } });

  const a = await t.sendText('private:1', '你好');
  assert.equal(a.ok, true);
  assert.equal(a.msgId, '101');
  assert.equal(client.calls.private[0].id, 1);
  assert.equal(client.calls.private[0].payload.data.text, '你好');

  const b = await t.sendText('group:456', '大家好');
  assert.equal(b.ok, true);
  assert.equal(b.msgId, '201');
  assert.equal(client.calls.group[0].id, 456);
});

test('传输层：非法 key 返回失败而不是抛错', async () => {
  const t = createSnowLumaTransport({ client: fakeClient() });
  const r = await t.sendText('guild:1', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /非法会话/);
});

test('传输层：发送异常被捕获', async () => {
  const client = fakeClient();
  client.sendPrivateMessage = async () => { throw new Error('ws closed'); };
  const t = createSnowLumaTransport({ client });
  const r = await t.sendText('private:1', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /ws closed/);
});

test('传输层：start/stop 幂等', () => {
  const client = fakeClient();
  const t = createSnowLumaTransport({ client });
  t.start();
  t.start();
  t.stop();
  assert.equal(client.calls.connects, 1);
  assert.equal(client.calls.closes, 1);
});

test('干跑模式：只记录不发送', async () => {
  const qq = createDryRunQq({});
  const r = await qq.sendText('private:1', 'hi');
  assert.equal(r.ok, true);
  assert.equal(qq.sent.length, 1);
  assert.equal(qq.sent[0].message, 'hi');
});

test('传输层：图片/语音/拍一拍/成员/详情', async () => {
  const calls = [];
  const client = {
    onPrivateMessage() {}, onGroupMessage() {}, onNotice() {},
    async sendPrivateMessage(id, payload) { calls.push({ kind: 'private', id, payload }); return { message_id: 1 }; },
    async sendGroupMessage(id, payload) { calls.push({ kind: 'group', id, payload }); return { message_id: 2 }; },
    async getMessage(id) { return { message_id: id, message: [{ type: 'image', data: { file: 'a.png' } }] }; },
    async getGroupMemberList(gid) { return [{ user_id: 9, nickname: '小明', card: '小明' }]; },
    async sendPoke(uid, opts) { calls.push({ kind: 'poke', uid, opts }); },
    async getForwardMessage(params) { return { id: params.id, messages: [] }; },
  };
  const built = {
    text: (s) => ({ type: 'text', data: { text: s } }),
    image: (s) => ({ type: 'image', data: { file: s } }),
    record: (s) => ({ type: 'record', data: { file: s } }),
  };
  const t = createSnowLumaTransport({ client, builder: built, voicesDir: 'E:/tmp/voices' });

  await t.sendImage('group:456', 'https://x/1.png');
  assert.deepEqual(calls.at(-1).payload, { type: 'image', data: { file: 'https://x/1.png' } });

  await t.sendVoice('private:1', '晚安.wav');
  const voice = calls.at(-1);
  assert.equal(voice.payload.type, 'record');
  assert.match(voice.payload.data.file, /voices/);

  const members = await t.groupMembers(456);
  assert.equal(members[0].userId, '9');

  const detail = await t.messageDetail(1);
  assert.equal(detail.message[0].type, 'image');

  const fwd = await t.forwardMsg('f1');
  assert.equal(fwd.id, 'f1');

  await t.sendPoke('group:456', 9);
  assert.equal(calls.at(-1).opts.group_id, 456);
});

test('传输层：收藏表情从消息详情取图', async () => {
  const client = {
    onPrivateMessage() {}, onGroupMessage() {}, onNotice() {},
    async getMessage(id) { return { message: [{ type: 'image', data: { file: 's.png' } }] }; },
  };
  const t = createSnowLumaTransport({ client });
  const r = await t.collectSticker(1, '好图');
  assert.equal(r.ok, true);
  assert.equal(r.sticker.url, 's.png');
});