import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTENTS,
  buildRouterPrompt,
  buildScopeInstructions,
  buildScopeSettings,
  parseRouterResult,
  scopeFor,
} from '../src/intent-router.js';
import { buildAgyArgs } from '../src/agent-cli.js';

test('읽기 전용 의도는 변경 명령을 막고 dev 변경 스킬을 넘기지 않는다', () => {
  for (const intent of ['data_query', 'error_analysis']) {
    const scope = scopeFor(intent);
    assert.deepEqual(scope.skills, ['mody-operations']);
    const settings = JSON.parse(buildScopeSettings(intent));
    for (const command of ['git commit', 'git push', 'gh pr', './gradlew']) {
      assert.ok(settings.permissions.deny.includes(`command(${command})`), `${intent}: ${command}`);
    }
  }
});

test('change와 general은 기존 동작처럼 스킬 두 개, 금지 명령 없음', () => {
  for (const intent of ['change', 'general']) {
    assert.deepEqual(scopeFor(intent).skills, ['mody-operations', 'mody-dev-operations']);
    assert.equal(buildScopeSettings(intent), '');
  }
});

test('모르는 의도는 general 범위로 간다', () => {
  assert.equal(scopeFor('deploy_everything'), scopeFor('general'));
});

test('분류 결과: 확신이 낮거나 형식이 틀리면 general로 보낸다', () => {
  assert.deepEqual(parseRouterResult('{"intent":"data_query","confidence":0.9,"reason":"x"}'), { intent: 'data_query', confidence: 0.9 });
  assert.equal(parseRouterResult('{"intent":"data_query","confidence":0.5}').intent, 'general');
  assert.equal(parseRouterResult('{"intent":"data_query","confidence":0.5}').proposed, 'data_query');
  assert.equal(parseRouterResult('{"intent":"rm_rf","confidence":1}').intent, 'general');
  assert.equal(parseRouterResult('not json').intent, 'general');
  assert.equal(parseRouterResult('{"intent":"change"}').intent, 'general');
});

test('최소 확신값을 바꿀 수 있다', () => {
  assert.equal(parseRouterResult('{"intent":"change","confidence":0.6}', { minConfidence: 0.5 }).intent, 'change');
});

test('분류 프롬프트에 스레드 맥락과 의도 목록이 들어간다', () => {
  const prompt = buildRouterPrompt({ text: '체크해줘', threadContext: '외부 봇: 500 에러 발생' });
  assert.match(prompt, /500 에러 발생/);
  for (const intent of INTENTS) {
    assert.match(prompt, new RegExp(`- ${intent}:`));
  }
  assert.match(buildRouterPrompt({ text: '' }), /멘션만 있음/);
});

test('읽기 전용 의도의 실행 지시에는 변경 금지가 들어간다', () => {
  assert.match(buildScopeInstructions('data_query').join('\n'), /바꾸지 않는다/);
  assert.deepEqual(buildScopeInstructions('general'), []);
});

test('agy 인자에 --settings가 프롬프트보다 앞에 들어간다', () => {
  const args = buildAgyArgs({ prompt: 'p', settings: buildScopeSettings('data_query') });
  const index = args.indexOf('--settings');
  assert.ok(index >= 0);
  assert.ok(index < args.findIndex((arg) => arg.startsWith('--print=')));
  assert.equal(buildAgyArgs({ prompt: 'p' }).includes('--settings'), false);
});
