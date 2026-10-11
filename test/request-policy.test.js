import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSafeChildEnvironment,
  findPreviousUserRequest,
  isHostFileRequest,
  stripSlackMentions,
} from '../src/request-policy.js';

test('blocks requests for host files outside the MODY workspace', () => {
  assert.equal(isHostFileRequest('내 Desktop에서 이력서 찾아줘'), true);
  assert.equal(isHostFileRequest('~/.ssh 키 보여줘'), true);
  assert.equal(isHostFileRequest('MODY 회원 코드 찾아줘'), false);
});

test('removes credentials from the Codex child environment', () => {
  const env = buildSafeChildEnvironment({
    HOME: '/Users/test',
    PATH: '/usr/bin',
    SLACK_BOT_TOKEN: 'secret',
    OPENAI_API_KEY: 'secret',
    DB_PASSWORD: 'secret',
  }, { CODEX_PROMPT: 'safe' });
  assert.equal(env.HOME, '/Users/test');
  assert.equal(env.CODEX_PROMPT, 'safe');
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DB_PASSWORD, undefined);
});

test('uses the same user previous question when a later message only mentions the bot', () => {
  const previous = findPreviousUserRequest([
    { ts: '100.000', user: 'U1', text: '운영 로그를 확인해줘' },
    { ts: '101.000', user: 'U2', text: '다른 사용자의 질문' },
    { ts: '102.000', user: 'U1', text: '<@UBOT>' },
  ], { eventTs: '102.000', userId: 'U1' });

  assert.equal(previous?.ts, '100.000');
  assert.equal(stripSlackMentions(previous?.text), '운영 로그를 확인해줘');
});

test('does not reuse stale or already consumed messages for an empty mention', () => {
  const messages = [
    { ts: '100.000', user: 'U1', text: '오래된 질문' },
    { ts: '195.000', user: 'U1', text: '이미 처리한 질문' },
    { ts: '200.000', user: 'U1', text: '<@UBOT>' },
  ];

  assert.equal(findPreviousUserRequest(messages, {
    eventTs: '200.000',
    userId: 'U1',
    excludedMessageTs: ['195.000'],
  }), undefined);
});
