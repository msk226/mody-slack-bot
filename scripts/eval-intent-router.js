// 의도 분류기 회귀 평가.
// 사용: node scripts/eval-intent-router.js [cases.jsonl] [--model=...] [--min-confidence=0.7]
// - cases.jsonl 한 줄: {"channel","ts","thread_ts","expected","needs_write"}. 요청 원문은 저장하지 않고 실행할 때 Slack에서 읽는다.
// - 스레드 맥락은 요청 시점 이전 메시지만 쓴다(봇이 실제로 받았을 맥락과 같게).
// - 결과는 eval/results-*.json에 저장한다. eval/는 git에 올리지 않는다(요청 원문·사용자 데이터 포함).
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebClient } from '@slack/web-api';
import { buildAgyArgs, parseAgyOutput } from '../src/agent-cli.js';
import { messageText } from '../src/grafana-alert.js';
import { buildRouterPrompt, parseRouterResult, DEFAULT_MIN_CONFIDENCE, INTENTS } from '../src/intent-router.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const casesPath = args.find((a) => !a.startsWith('--')) ?? path.join(ROOT, 'eval', 'intent-cases.jsonl');
const model = flag('model', process.env.INTENT_ROUTER_MODEL ?? 'gemini-3.8-flash-low');
const minConfidence = Number(flag('min-confidence', DEFAULT_MIN_CONFIDENCE));
const agyPath = process.env.AGY_PATH ?? path.join(os.homedir(), '.local', 'bin', 'agy');
const schemaPath = path.join(ROOT, 'config', 'intent-router.schema.json');
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const BOT_MENTION = /<@[A-Z0-9]+(?:\|[^>]+)?>/g;

function clean(text = '') {
  return text
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '[redacted-token]')
    .replace(BOT_MENTION, '')
    .trim()
    .slice(0, 4000);
}

async function loadCase(c) {
  const replies = await slack.conversations.replies({ channel: c.channel, ts: c.thread_ts, limit: 200, inclusive: true });
  const messages = replies.messages ?? [];
  const target = messages.find((m) => m.ts === c.ts);
  if (!target) throw new Error(`message not found: ${c.ts}`);
  const before = messages.filter((m) => Number(m.ts) < Number(c.ts)).slice(-30);
  const threadContext = before
    .map((m) => `${m.bot_id ? '봇' : '사용자'}: ${clean(messageText(m))}`)
    .filter((line) => !line.endsWith(': '))
    .join('\n');
  return { text: clean(messageText(target)), threadContext };
}

async function classify({ text, threadContext }) {
  const started = Date.now();
  const agyArgs = buildAgyArgs({
    prompt: buildRouterPrompt({ text, threadContext }),
    model,
    effort: 'low',
    timeoutMs: 60_000,
    schemaPath,
  });
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(agyPath, agyArgs, { timeout: 90_000, maxBuffer: 4 * 1024 * 1024, cwd: os.tmpdir() }));
  } catch (error) {
    stdout = error.stdout ?? '';
  }
  const raw = parseAgyOutput(stdout);
  const route = raw ? parseRouterResult(raw, { minConfidence }) : { intent: 'general', confidence: 0, fallback: 'router_failed' };
  let reason = '';
  try { reason = JSON.parse(raw).reason ?? ''; } catch { /* 무시 */ }
  return { ...route, reason, ms: Date.now() - started };
}

const cases = (await readFile(casesPath, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rows = [];
for (const [i, c] of cases.entries()) {
  const input = await loadCase(c);
  const out = await classify(input);
  const ok = out.intent === c.expected;
  rows.push({ ...c, text: input.text, contextLines: input.threadContext ? input.threadContext.split('\n').length : 0, ...out, ok });
  console.log(`${String(i + 1).padStart(2)} ${ok ? 'OK  ' : 'MISS'} expected=${c.expected.padEnd(14)} got=${out.intent.padEnd(14)} conf=${out.confidence}${out.fallback ? ` (${out.fallback}${out.proposed ? `:${out.proposed}` : ''})` : ''} ${out.ms}ms`);
}

const readOnly = new Set(['data_query', 'error_analysis']);
const correct = rows.filter((r) => r.ok).length;
// 위험한 오분류: 무언가를 바꿔야 하는 요청을 읽기 전용으로 좁혀 버려서 작업을 못 하게 되는 경우
const unsafe = rows.filter((r) => r.needs_write && readOnly.has(r.intent)).length;
// 놓친 좁히기: 읽기 전용으로 좁힐 수 있었는데 general·change로 보낸 경우(기존 동작과 같음)
const missed = rows.filter((r) => readOnly.has(r.expected) && !readOnly.has(r.intent)).length;
const narrowed = rows.filter((r) => readOnly.has(r.intent) && r.intent === r.expected).length;
const confusion = Object.fromEntries(INTENTS.map((e) => [e, Object.fromEntries(INTENTS.map((g) => [g, rows.filter((r) => r.expected === e && r.intent === g).length]))]));
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const summary = {
  model,
  minConfidence,
  total: rows.length,
  correct,
  readOnlyExpected: rows.filter((r) => readOnly.has(r.expected)).length,
  narrowedCorrectly: narrowed,
  unsafeNarrowing: unsafe,
  missedNarrowing: missed,
  medianMs: ms[Math.floor(ms.length / 2)],
  confusion,
};
console.log(JSON.stringify(summary, null, 2));
await mkdir(path.join(ROOT, 'eval'), { recursive: true });
const out = path.join(ROOT, 'eval', `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(out, JSON.stringify({ summary, rows }, null, 2));
console.log(`saved ${out}`);
