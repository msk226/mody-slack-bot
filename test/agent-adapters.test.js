import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAgentAdapter,
  listAgentProviders,
  parseFallbackProviders,
  parseProviderOverride,
  resolveAdapterChain,
  resolveTaskStrategy,
} from '../src/agent-adapters/index.js';

test('지원하는 프로바이더 목록과 어댑터 조회가 동작한다', () => {
  assert.deepEqual(listAgentProviders(), ['agy', 'claude', 'codex']);
  assert.equal(getAgentAdapter('AGY').name, 'agy');
  assert.equal(getAgentAdapter('claude').name, 'claude');
  assert.equal(getAgentAdapter('codex').name, 'codex');
  assert.throws(() => getAgentAdapter('unknown-ai'), /지원하지 않는 AI 어댑터/);
});

test('claude 어댑터는 인자 생성과 JSON 응답 파싱을 처리한다', () => {
  const adapter = getAgentAdapter('claude');
  const args = adapter.buildArgs({
    prompt: 'hello',
    model: 'claude-sonnet-4-6',
    schemaPath: '/tmp/s.json',
    settings: '{"permissions":{"deny":["Bash(git *)"]}}',
    addDirs: ['/tmp/skill'],
  });
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('--json-schema'));
  assert.ok(args.includes('--settings'));
  assert.deepEqual(args.slice(-2), ['-p', 'hello']);

  assert.equal(adapter.parseOutput(JSON.stringify({ result: 'ok', is_error: false })), 'ok');
  assert.equal(
    adapter.parseOutput(JSON.stringify({ structured_output: { a: 1 }, is_error: false })),
    '{"a":1}'
  );
  assert.equal(adapter.parseOutput(JSON.stringify({ result: 'bad', is_error: true })), '');
});

test('codex 어댑터는 readOnly 또는 settings 전달 시 --sandbox read-only를 강제한다', () => {
  const adapter = getAgentAdapter('codex');
  const roArgs = adapter.buildArgs({
    prompt: 'check db',
    settings: '{"permissions":{"deny":["Bash(rm *)"]}}',
    schemaPath: '/tmp/schema.json',
  });
  const sandboxIdx = roArgs.indexOf('--sandbox');
  assert.equal(roArgs[sandboxIdx + 1], 'read-only');
  assert.ok(roArgs.includes('--output-schema'));

  const rwArgs = adapter.buildArgs({ prompt: 'fix bug', readOnly: false });
  assert.equal(rwArgs[rwArgs.indexOf('--sandbox') + 1], 'workspace-write');

  assert.equal(adapter.parseOutput('plain answer'), 'plain answer');
  assert.equal(adapter.parseOutput(JSON.stringify({ summary: 'ok' })), '{"summary":"ok"}');
  assert.equal(adapter.parseOutput(JSON.stringify({ error: 'boom' })), '');
});

test('resolveAdapterChain은 중복을 제거하고 primary -> fallback 순서를 유지한다', () => {
  const fallbacks = parseFallbackProviders('claude, agy, codex');
  const chain = resolveAdapterChain({ provider: 'agy', fallbackProviders: fallbacks });
  assert.deepEqual(chain.map((a) => a.name), ['agy', 'claude', 'codex']);
});

test('parseProviderOverride는 멘션 앞의 [provider] 접두어를 분리한다', () => {
  assert.deepEqual(parseProviderOverride('[claude] 에러 분석해줘'), {
    provider: 'claude',
    text: '에러 분석해줘',
  });
  assert.deepEqual(parseProviderOverride('그냥 질문'), {
    provider: null,
    text: '그냥 질문',
  });
});

test('resolveTaskStrategy는 작업별 라우팅과 폴백 시 프로바이더별 모델을 분리한다', () => {
  const attempts = resolveTaskStrategy({
    label: 'error-analysis',
    defaultProvider: 'agy',
    fallbackProviders: ['claude', 'codex'],
    taskRoutes: {
      'error-analysis': { provider: 'claude', model: 'claude-sonnet-4-6' },
    },
    providerModels: {
      agy: 'gemini-4-neon-medium',
      claude: 'claude-haiku-4-5',
      codex: 'gpt-5.3-codex',
    },
  });
  assert.deepEqual(
    attempts.map((a) => ({ provider: a.adapter.name, model: a.model })),
    [
      { provider: 'claude', model: 'claude-sonnet-4-6' },
      { provider: 'codex', model: 'gpt-5.3-codex' },
    ]
  );

  // overrideProvider가 지정되면 다른 프로바이더의 explicitModel이 섞이지 않는다
  const overridden = resolveTaskStrategy({
    label: 'mention',
    overrideProvider: 'codex',
    defaultProvider: 'agy',
    fallbackProviders: ['agy'],
    providerModels: { agy: 'gemini-4-neon-medium', codex: 'gpt-5.3-codex' },
    explicitModel: 'gemini-4-neon-medium',
  });
  assert.equal(overridden[0].adapter.name, 'codex');
  assert.equal(overridden[0].model, 'gpt-5.3-codex');
  assert.equal(overridden[1].adapter.name, 'agy');
  assert.equal(overridden[1].model, 'gemini-4-neon-medium');
});
