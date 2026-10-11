import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSafeChildEnvironment,
  findPreviousUserRequest,
  isHealthQuestion,
  isHostFileRequest,
  isThreadSummaryRequest,
  isVersionQuestion,
  stripSlackMentions,
} from '../src/request-policy.js';

test('treats only explicit summary requests as thread summaries', () => {
  assert.equal(isThreadSummaryRequest('이 thread 요약해줘'), true);
  assert.equal(isThreadSummaryRequest('대화 내용 정리해줘'), true);
  assert.equal(isThreadSummaryRequest('이 thread 참고해서 PR 열어줘'), false);
  assert.equal(isThreadSummaryRequest('dev 데이터 정리해줘'), false);
  assert.equal(isThreadSummaryRequest('에러 원인 요약해서 이슈 만들어줘'), false);
});

test('answers bot health only when no service target is named', () => {
  assert.equal(isHealthQuestion('상태 알려줘'), true);
  assert.equal(isHealthQuestion('봇 살아있어?'), true);
  assert.equal(isHealthQuestion('운영 서버 상태 확인해줘'), false);
  assert.equal(isHealthQuestion('운영에서 이 회원의 챌린지 달성 상태를 보고 코드 조건과도 대조해줘'), false);
  assert.equal(isHealthQuestion('알림 작동해?'), false);
});

test('answers version questions only about the bot itself', () => {
  assert.equal(isVersionQuestion('이전 버전과 달라진 점 알려줘'), true);
  assert.equal(isVersionQuestion('봇 뭐가 바뀌었어?'), true);
  assert.equal(isVersionQuestion('어떤 API가 변경됐는지 알려줘'), false);
  assert.equal(isVersionQuestion('기존 버전에서 변경된 코드 찾아줘'), false);
});

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
