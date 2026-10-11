import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createDeployNotifier,
  deployVersion,
  pullRequestsFromCommits,
  renderDeployMessage,
} from '../src/deploy-notifier.js';

const repo = 'org/mody-server';

function run(id, createdAt, conclusion, headSha, extra = {}) {
  const finishedAt = new Date(Date.parse(createdAt) + 4 * 60_000 + 5_000).toISOString();
  return {
    databaseId: id,
    status: 'completed',
    conclusion,
    createdAt,
    updatedAt: finishedAt,
    headSha,
    displayTitle: `Merge pull request #${id} from org/feature`,
    url: `https://github.com/${repo}/actions/runs/${id}`,
    ...extra,
  };
}

test('numbers successful deploys per KST day and skips failures', () => {
  const runs = [
    run(1, '2026-10-10T15:30:00Z', 'success', 'a'),
    run(2, '2026-10-11T02:20:00Z', 'success', 'b'),
    run(3, '2026-10-11T06:53:00Z', 'cancelled', 'c'),
    run(4, '2026-10-11T07:09:00Z', 'success', 'd'),
    run(5, '2026-10-10T04:00:00Z', 'success', 'e'),
  ];
  assert.equal(deployVersion(runs[0], runs), 'v2026.10.11-1');
  assert.equal(deployVersion(runs[1], runs), 'v2026.10.11-2');
  assert.equal(deployVersion(runs[2], runs), null);
  assert.equal(deployVersion(runs[3], runs), 'v2026.10.11-3');
  assert.equal(deployVersion(runs[4], runs), 'v2026.10.10-1');
});

test('finds PR numbers from merge and squash commits once each', () => {
  assert.deepEqual(pullRequestsFromCommits([
    'Merge pull request #226 from org/fix/224\n\n본문',
    'fix(deploy): 단일 인스턴스로 전환',
    'feat: 리포트 추가 (#222)',
    'Merge pull request #226 from org/fix/224',
  ]), ['226', '222']);
});

test('renders success, failure, cancel, and unchanged deploys', () => {
  const success = run(10, '2026-10-11T07:09:11Z', 'success', '782ecc8aaaa', { updatedAt: '2026-10-11T07:17:06Z' });
  assert.equal(renderDeployMessage({
    run: success,
    version: 'v2026.10.11-2',
    changes: { pulls: [{ number: '226', title: '단일 인스턴스 배포로 전환' }] },
    repo,
  }), [
    '🚀 *운영 배포 완료* · `v2026.10.11-2`',
    `• <https://github.com/${repo}/pull/226|#226> 단일 인스턴스 배포로 전환`,
    `커밋 \`782ecc8\` · 16:17 완료 · 소요 7분 55초 · <${success.url}|실행 기록>`,
  ].join('\n'));

  const failure = renderDeployMessage({
    run: run(11, '2026-10-11T07:09:11Z', 'failure', 'abc1234'),
    changes: { commits: ['fix: 설정 수정'] },
    failedStep: 'deploy / Run deploy script',
    repo,
  });
  assert.match(failure, /^❌ \*운영 배포 실패\*/);
  assert.match(failure, /• fix: 설정 수정/);
  assert.match(failure, /• 실패 단계: deploy \/ Run deploy script/);
  assert.match(failure, /16:13 종료/);

  assert.match(renderDeployMessage({ run: run(12, '2026-10-11T06:53:57Z', 'cancelled', 'c'), repo }), /^⏹ \*운영 배포 취소\*\n• Merge pull request #12/);
  assert.match(renderDeployMessage({ run: success, version: 'v1', changes: { unchanged: true }, repo }), /• 변경 없음 \(직전 배포와 같은 커밋\)/);
});

function fakeGh({ runs, compare = {}, pulls = {}, jobs = {} }) {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'run' && args[1] === 'list') return { stdout: JSON.stringify(runs) };
    if (args[0] === 'run' && args[1] === 'view') return { stdout: JSON.stringify({ jobs: jobs[args[2]] ?? [] }) };
    if (args[0] === 'api' && args[1].includes('/compare/')) return { stdout: JSON.stringify(compare[args[1].split('/compare/')[1]] ?? []) };
    if (args[0] === 'api' && args[1].includes('/pulls/')) return { stdout: `${pulls[args[1].split('/pulls/')[1]] ?? ''}\n` };
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { runGh, calls };
}

async function tempStateFile() {
  return path.join(await mkdtemp(path.join(os.tmpdir(), 'deploy-notifier-')), 'state.json');
}

test('on first start posts only the latest deploy with PRs since the previous success', async () => {
  const runs = [
    run(2, '2026-10-11T07:09:11Z', 'success', 'head'),
    run(1, '2026-10-11T02:20:46Z', 'success', 'base'),
    { ...run(3, '2026-10-11T08:00:00Z', 'success', 'next'), status: 'in_progress', conclusion: '' },
  ];
  const { runGh } = fakeGh({
    runs,
    compare: { 'base...head': ['Merge pull request #225 from org/feature/224', 'feat: 블루그린', 'Merge pull request #226 from org/fix/224'] },
    pulls: { 225: '블루그린 무중단 배포', 226: '단일 인스턴스 배포로 전환' },
  });
  const posts = [];
  const stateFile = await tempStateFile();
  const poll = createDeployNotifier({ repo, runGh, post: async (text) => posts.push(text), stateFile });

  const results = await poll();
  assert.deepEqual(results.map((result) => result.runId), [2]);
  assert.match(posts[0], /`v2026\.10\.11-2`/);
  assert.match(posts[0], /#225> 블루그린 무중단 배포\n• <.*\|#226> 단일 인스턴스 배포로 전환/);
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).postedRunIds, [1, 2]);

  assert.deepEqual(await poll(), []);
  assert.equal(posts.length, 1);
});

test('posts newly finished deploys and names the failed step', async () => {
  const runs = [
    run(1, '2026-10-11T02:20:46Z', 'success', 'base'),
    run(2, '2026-10-11T07:09:11Z', 'failure', 'head'),
  ];
  const { runGh, calls } = fakeGh({
    runs,
    compare: { 'base...head': ['fix: 설정 수정'] },
    jobs: { 2: [{ name: 'deploy', conclusion: 'failure', steps: [{ name: 'Run deploy script', conclusion: 'failure' }] }] },
  });
  const posts = [];
  const stateFile = await tempStateFile();
  const poll = createDeployNotifier({ repo, runGh, post: async (text) => posts.push(text), stateFile });

  await poll();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /^❌ \*운영 배포 실패\*\n• fix: 설정 수정\n• 실패 단계: deploy \/ Run deploy script/);
  assert.ok(calls.some((call) => call.startsWith('run view 2')));
});
