import test from 'node:test';
import assert from 'node:assert/strict';
import { inferEnvironment, parseAgentResult, renderAgentResult } from '../src/agent-contract.js';

test('infers explicitly requested environments', () => {
  assert.equal(inferEnvironment('운영 DB와 dev DB 비교해줘'), 'mixed');
  assert.equal(inferEnvironment('prod 회원 상태 확인'), 'prod');
  assert.equal(inferEnvironment('개발 서버 확인'), 'dev');
  assert.equal(inferEnvironment('이 코드 어디서 써?'), 'none');
});

test('renders a consistent Slack response', () => {
  const result = parseAgentResult(JSON.stringify({
    status: 'completed',
    environment: 'prod',
    summary: '회원 상태는 정상입니다.',
    facts: [{ label: '회원', value: '1234' }],
    explanation: '활성 상태로 확인됐습니다.',
    actions: [],
    warnings: [],
  }));

  const rendered = renderAgentResult(result, 'MODY-20260920-0001');
  assert.match(rendered, /\*처리 결과\*/);
  assert.match(rendered, /환경: 운영/);
  assert.match(rendered, /확인 ID: MODY-20260920-0001/);
});

test('keeps the request id when a long result is cut', () => {
  const longValue = 'a'.repeat(5000);
  const raw = JSON.stringify({ status: 'completed', environment: 'prod', summary: '추출했습니다.', explanation: longValue });
  assert.ok(raw.length > 2800);

  const rendered = renderAgentResult(parseAgentResult(raw), 'MODY-20261020-0001');
  assert.ok(rendered.length < 3000);
  assert.match(rendered, /\n\.\.\.\n\n_확인 ID: MODY-20261020-0001_$/);
});
