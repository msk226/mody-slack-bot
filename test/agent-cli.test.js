import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgyArgs, parseAgyOutput } from '../src/agent-cli.js';

test('builds non-interactive agy arguments with the prompt attached last', () => {
  const args = buildAgyArgs({
    prompt: '--model 처럼 보이는 프롬프트',
    model: 'gemini-4-argon-medium',
    effort: 'medium',
    timeoutMs: 1_200_000,
    schemaPath: '/tmp/schema.json',
    addDirs: ['/skills/mody-operations'],
  });
  assert.deepEqual(args, [
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--model', 'gemini-4-argon-medium',
    '--effort', 'medium',
    '--print-timeout', '1200s',
    '--json-schema', '/tmp/schema.json',
    '--add-dir', '/skills/mody-operations',
    '--print=--model 처럼 보이는 프롬프트',
  ]);
});

test('omits the print timeout and schema when not set', () => {
  const args = buildAgyArgs({ prompt: 'hi', model: 'm', effort: '' });
  assert.equal(args.includes('--print-timeout'), false);
  assert.equal(args.includes('--json-schema'), false);
  assert.equal(args.includes('--effort'), false);
  assert.equal(args.at(-1), '--print=hi');
});

test('reads the text response from agy json output', () => {
  const stdout = JSON.stringify({ status: 'SUCCESS', response: 'src, docs, gradle\n' });
  assert.equal(parseAgyOutput(stdout), 'src, docs, gradle');
});

test('prefers structured output when a schema was used', () => {
  const stdout = JSON.stringify({
    status: 'SUCCESS',
    response: '{"summary":"x","toolAction":"extra"}',
    structured_output: { summary: 'x', facts: [] },
  });
  assert.deepEqual(JSON.parse(parseAgyOutput(stdout)), { summary: 'x', facts: [] });
});

test('returns empty text for failed or malformed output', () => {
  assert.equal(parseAgyOutput(JSON.stringify({ status: 'ERROR', response: 'nope' })), '');
  assert.equal(parseAgyOutput('not json'), '');
  assert.equal(parseAgyOutput(''), '');
});
