import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_LISTED_PULLS = 15;
const MAX_LISTED_COMMITS = 5;
const RUN_FIELDS = 'databaseId,status,conclusion,createdAt,updatedAt,headSha,displayTitle,url';

export function kstDate(iso) {
  return new Date(Date.parse(iso) + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function kstTime(iso) {
  return new Date(Date.parse(iso) + KST_OFFSET_MS).toISOString().slice(11, 16);
}

// 버전 규칙: 성공한 운영 배포에만 v{KST 날짜}-{그날 몇 번째 성공 배포}를 붙인다.
// GitHub 실행 기록만으로 계산하므로 상태 파일이 사라져도 같은 번호가 나온다.
export function deployVersion(run, runs) {
  if (run.conclusion !== 'success') return null;
  const date = kstDate(run.createdAt);
  const order = runs.filter((item) => item.conclusion === 'success'
    && kstDate(item.createdAt) === date
    && item.createdAt <= run.createdAt).length;
  return `v${date.replaceAll('-', '.')}-${order}`;
}

export function previousSuccess(run, runs) {
  return runs
    .filter((item) => item.conclusion === 'success' && item.createdAt < run.createdAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

// 머지 커밋('Merge pull request #n …')과 스쿼시 커밋('… (#n)')에서 PR 번호를 찾는다.
export function pullRequestsFromCommits(messages) {
  const numbers = [];
  for (const message of messages) {
    const title = message.split('\n')[0];
    const number = title.match(/^Merge pull request #(\d+)/)?.[1] ?? title.match(/\(#(\d+)\)\s*$/)?.[1];
    if (number && !numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

export function formatDuration(run) {
  const seconds = Math.max(0, Math.round((Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}분 ${seconds % 60}초` : `${seconds}초`;
}

function changeLines({ pulls = [], commits = [], unchanged = false }, run, repo) {
  if (pulls.length > 0) {
    const lines = pulls
      .slice(0, MAX_LISTED_PULLS)
      .map((pull) => `• <https://github.com/${repo}/pull/${pull.number}|#${pull.number}> ${pull.title}`.trimEnd());
    if (pulls.length > MAX_LISTED_PULLS) lines.push(`• 외 ${pulls.length - MAX_LISTED_PULLS}건`);
    return lines;
  }
  if (commits.length > 0) return commits.slice(0, MAX_LISTED_COMMITS).map((title) => `• ${title}`);
  if (unchanged) return ['• 변경 없음 (직전 배포와 같은 커밋)'];
  return [`• ${run.displayTitle}`];
}

export function renderDeployMessage({ run, version, changes = {}, failedStep, repo }) {
  const heading = {
    success: `🚀 *운영 배포 완료* · \`${version}\``,
    failure: '❌ *운영 배포 실패*',
    cancelled: '⏹ *운영 배포 취소*',
  }[run.conclusion] ?? `⚠️ *운영 배포 종료 (${run.conclusion || run.status})*`;
  const finished = run.conclusion === 'success' ? '완료' : '종료';
  return [
    heading,
    ...changeLines(changes, run, repo),
    failedStep ? `• 실패 단계: ${failedStep}` : null,
    `커밋 \`${run.headSha.slice(0, 7)}\` · ${kstTime(run.updatedAt)} ${finished} · 소요 ${formatDuration(run)} · <${run.url}|실행 기록>`,
  ].filter(Boolean).join('\n');
}

export function createDeployNotifier({ repo, runGh, post, stateFile, workflow = 'deploy-prod.yml' }) {
  async function listRuns() {
    const { stdout } = await runGh(['run', 'list', '--repo', repo, '--workflow', workflow, '--limit', '20', '--json', RUN_FIELDS]);
    return JSON.parse(stdout);
  }

  // 이번 배포로 새로 나간 변경: 직전 성공 배포 커밋부터 이번 커밋까지.
  async function loadChanges(run, runs) {
    const base = previousSuccess(run, runs);
    if (!base) return {};
    if (base.headSha === run.headSha) return { unchanged: true };
    try {
      const { stdout } = await runGh(['api', `repos/${repo}/compare/${base.headSha}...${run.headSha}`, '-q', '[.commits[].commit.message]']);
      const messages = JSON.parse(stdout);
      const numbers = pullRequestsFromCommits(messages);
      if (numbers.length === 0) {
        return { commits: messages.map((message) => message.split('\n')[0]).filter((title) => !title.startsWith('Merge ')) };
      }
      const pulls = await Promise.all(numbers.map(async (number) => {
        try {
          const { stdout: title } = await runGh(['api', `repos/${repo}/pulls/${number}`, '-q', '.title']);
          return { number, title: title.trim() };
        } catch {
          return { number, title: '' };
        }
      }));
      return { pulls };
    } catch (error) {
      console.error('[deploy-notifier] failed to compare commits:', error?.stderr ?? error?.message ?? error);
      return {};
    }
  }

  async function loadFailedStep(run) {
    try {
      const { stdout } = await runGh(['run', 'view', String(run.databaseId), '--repo', repo, '--json', 'jobs']);
      const failed = (JSON.parse(stdout).jobs ?? [])
        .filter((job) => job.conclusion === 'failure')
        .map((job) => {
          const steps = (job.steps ?? []).filter((step) => step.conclusion === 'failure').map((step) => step.name);
          return steps.length > 0 ? `${job.name} / ${steps.join(', ')}` : job.name;
        });
      return failed.join('; ') || null;
    } catch {
      return null;
    }
  }

  return async function poll() {
    const runs = await listRuns();
    const completed = runs
      .filter((run) => run.status === 'completed')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let posted = (await readState(stateFile)).postedRunIds;
    if (!Array.isArray(posted)) {
      // 처음 켤 때는 지난 기록을 올리지 않고, 가장 최근 배포 하나만 올려 채널을 시작한다.
      posted = completed.slice(0, -1).map((run) => run.databaseId);
      await writeState(stateFile, { postedRunIds: posted });
    }

    const results = [];
    for (const run of completed.filter((item) => !posted.includes(item.databaseId))) {
      const changes = await loadChanges(run, runs);
      const failedStep = run.conclusion === 'failure' ? await loadFailedStep(run) : null;
      const text = renderDeployMessage({ run, version: deployVersion(run, runs), changes, failedStep, repo });
      await post(text);
      posted = [...posted, run.databaseId].slice(-100);
      await writeState(stateFile, { postedRunIds: posted });
      results.push({ runId: run.databaseId, text });
    }
    return results;
  };
}

export function startDeployNotifier({ poll, intervalMs = 60_000 }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const result of await poll()) {
        console.log(`[deploy-notifier] posted run ${result.runId}`);
      }
    } catch (error) {
      console.error('[deploy-notifier] failed:', error?.stderr ?? error?.data?.error ?? error?.message ?? error);
    } finally {
      running = false;
    }
  };

  tick();
  return setInterval(tick, intervalMs);
}

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}
