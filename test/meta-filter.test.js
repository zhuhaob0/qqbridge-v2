import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeProcessNarration } from '../src/orchestrator/meta-filter.js';

test('过程叙述：群里那句“没插进去/标成已读/继续潜水”要被拦下', () => {
  const text = 'void_love() @ 雨花石，说她偏爱这种片子。那话是冲雨花石说的，我没插进去，就标成已读继续说潜水。';
  assert.equal(looksLikeProcessNarration(text).meta, true);
});

test('过程叙述：已读水位、本轮观察这类判断也要拦', () => {
  for (const text of [
    '把消息标成已读，继续潜水',
    '本轮没有需要回复的内容',
    '这轮观察一下，先不插话',
    '等她说完再回，已读先',
  ]) {
    assert.equal(looksLikeProcessNarration(text).meta, true, text);
  }
});

test('过程叙述：旁观式描述 + 决定不参与', () => {
  assert.equal(looksLikeProcessNarration('void_love() 对雨花石说，听说喜家德不错，自己还没去吃过，这是他们俩的对话，我就不接话了。').meta, true);
  assert.equal(looksLikeProcessNarration('他们俩在聊天，我就不插话了').meta, true);
});

test('过程叙述：正常的聊天回复不能误伤', () => {
  for (const text of [
    '哈哈哈哈你怎么这么好笑',
    '你请客我就去',
    '那你说说看，我不潜水',
    '行，那我先去忙了，晚点聊',
    '这家店我吃过，味道一般',
    '他们在聊什么？',
    '妈妈对我说早点睡，我说知道了',
    '这家喜家德听说不错，改天去试试',
  ]) {
    assert.equal(looksLikeProcessNarration(text).meta, false, text);
  }
});

test('过程叙述：长文本不做过程判断（避免误杀长回复）', () => {
  const long = '潜水'.repeat(100);
  assert.equal(looksLikeProcessNarration(long).meta, false);
});
