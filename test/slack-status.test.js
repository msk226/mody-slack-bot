import test from 'node:test';
import assert from 'node:assert/strict';
import { alertEnvironment, formatStatusEmoji, setStatusReaction, slackMessage, stripStatusEmoji } from '../src/slack-status.js';

test('messages omit emoji and retain paragraph breaks in a mrkdwn section', () => {
  const message = slackMessage(':완료: *처리 결과*\n\n• 환경: :운영: 운영\n\n*확인 결과*\n40개');
  assert.deepEqual(message.blocks, [{ type: 'section', text: { type: 'mrkdwn', text: message.text } }]);
  assert.equal(message.text, '*처리 결과*\n\n• 환경: 운영\n\n*확인 결과*\n40개');
});

test('message emoji codes match Slack Hangul names without changing prose', () => {
  assert.equal(formatStatusEmoji(':완료: 완료했습니다.'), `:${'완료'.normalize('NFD')}: 완료했습니다.`);
  assert.equal(stripStatusEmoji(formatStatusEmoji(':확인중: 요청을 접수했습니다.')), '요청을 접수했습니다.');
});

test('environment comes from alert field, not exception text', () => {
  assert.equal(alertEnvironment('*Environment*: `dev`\n*Message*: prod failed'), 'dev');
  assert.equal(alertEnvironment('*Environment*: `prod`'), 'prod');
  assert.equal(alertEnvironment('*Message*: dev failed'), null);
});

test('status switches remove only bot status, preserving environment and user reactions', async () => {
  const calls = [];
  const client = { reactions: {
    add: async (args) => calls.push(['add', args.name]),
    remove: async (args) => calls.push(['remove', args.name]),
  } };
  const event = { channel: 'test', ts: '1' };
  await setStatusReaction(client, event, 'received');
  await setStatusReaction(client, event, 'running');
  await setStatusReaction(client, event, 'completed');
  assert.deepEqual(calls, [
    ['add', '확인중'], ['remove', '확인중'], ['add', 'loading'],
    ['remove', 'loading'], ['add', '완료'],
  ]);
});

test('decomposed Hangul names are supported before builtin fallback', async () => {
  const names = [];
  const client = { reactions: {
    add: async ({ name }) => {
      names.push(name);
      if (name === '완료') throw { data: { error: 'invalid_name' } };
    },
  } };
  await setStatusReaction(client, { channel: 'test', ts: '2' }, 'completed');
  assert.deepEqual(names, ['완료', '완료'.normalize('NFD')]);
});
