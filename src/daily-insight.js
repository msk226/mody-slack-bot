import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_SECONDS = 24 * 60 * 60;

export const INSIGHT_TITLE = '데일리 인사이트';

// daily_report.py의 report_text. 예전 리포트는 '데일리', 지금은 '일일'로 올라온다.
const REPORT_TEXT = /^MODY (?:일일|데일리) 리포트 (\d{4}-\d{2}-\d{2})/;
const TREND_EMOJI = { 'mody-up': '▲', 'mody-down': '▼', 'mody-flat': '–' };
const RUN_RESULT_LABELS = {
  success: '성공',
  failure: '실패',
  cancelled: '취소',
  in_progress: '진행 중',
  queued: '대기',
};

export function reportDateOf(message) {
  if (!message?.bot_id) return null;
  return message.text?.match(REPORT_TEXT)?.[1] ?? null;
}

// 같은 날짜 리포트가 여러 번 올라오면(강제 재발송) 가장 최근 메시지를 쓴다.
export function pickReports(messages = []) {
  const byDate = new Map();
  for (const message of messages) {
    const date = reportDateOf(message);
    if (!date) continue;
    const current = byDate.get(date);
    if (!current || Number(message.ts) > Number(current.ts)) {
      byDate.set(date, { date, ts: message.ts, text: flattenReportBlocks(message.blocks) || message.text });
    }
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

// 리포트의 Block Kit을 분석용 텍스트로 바꾼다. 증감 이모지는 ▲▼–로 바꾼다.
export function flattenReportBlocks(blocks = []) {
  const inline = (elements = []) => elements.map((element) => {
    if (element.type === 'text') return element.text;
    if (element.type === 'emoji') return TREND_EMOJI[element.name] ?? '';
    if (element.type === 'link') return element.text ?? element.url;
    return '';
  }).join('');

  const lines = [];
  for (const block of blocks ?? []) {
    if (block.type === 'header' || block.type === 'section') {
      lines.push(block.text?.text ?? '');
    } else if (block.type === 'context') {
      lines.push(...(block.elements ?? []).map((element) => element.text ?? ''));
    } else if (block.type === 'rich_text') {
      for (const element of block.elements ?? []) {
        if (element.type === 'rich_text_section') {
          lines.push(inline(element.elements));
        } else if (element.type === 'rich_text_list') {
          const indent = '  '.repeat(element.indent ?? 0);
          lines.push(...(element.elements ?? []).map((item) => `${indent}- ${inline(item.elements).trim()}`));
        }
      }
    }
  }
  // 리포트 끝의 안내 문구(💬)는 지표가 아니라서 뺀다.
  return lines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.startsWith('💬'))
    .join('\n');
}

export function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// KST 기준 하루의 시작과 끝(Unix 초).
export function kstDayRange(date) {
  const start = Date.parse(`${date}T00:00:00+09:00`) / 1000;
  return { start, end: start + DAY_SECONDS };
}

// 지금 분석할 리포트 날짜. 리포트는 전날 지표라서, 리포트 시각이 지나면 어제 날짜를 본다.
export function dueReportDate(nowMs, time, state = {}) {
  const [hour, minute] = time.split(':').map(Number);
  const nowKst = new Date(nowMs + KST_OFFSET_MS);
  if (nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes() < hour * 60 + minute) return null;
  const target = addDays(nowKst.toISOString().slice(0, 10), -1);
  return state.lastReportDate === target ? null : target;
}

export function summarizeErrorAlerts(messages, { parseServerError, isIgnoredNoise, alertEnvironment }) {
  const counts = new Map();
  const byEnvironment = new Map();
  let total = 0;
  for (const message of messages) {
    const parsed = message.text ? parseServerError(message.text) : null;
    if (!parsed || isIgnoredNoise(parsed)) continue;
    const environment = alertEnvironment(message.text) ?? '환경 미표기';
    const target = [parsed.method, parsed.path ?? parsed.request].filter(Boolean).join(' ');
    const key = `${environment} · ${target} · ${parsed.exception}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    byEnvironment.set(environment, (byEnvironment.get(environment) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return '에러 알림 없음';

  const perEnvironment = [...byEnvironment].map(([environment, count]) => `${environment} ${count}건`).join(', ');
  const top = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => `- ${key}: ${count}건`);
  return [`총 ${total}건 (${perEnvironment})`, ...top].join('\n');
}

export function summarizeDeploys(runs, { since, until }) {
  const lines = runs
    .filter((run) => {
      const at = Date.parse(run.createdAt);
      return at >= since && at < until;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((run) => {
      const kst = new Date(Date.parse(run.createdAt) + KST_OFFSET_MS).toISOString();
      const when = `${kst.slice(5, 7)}/${kst.slice(8, 10)} ${kst.slice(11, 16)}`;
      const result = RUN_RESULT_LABELS[run.conclusion] || RUN_RESULT_LABELS[run.status] || run.conclusion || run.status || '';
      return `- ${when} ${result}: ${run.displayTitle}`;
    });
  return lines.length > 0 ? lines.join('\n') : '해당 기간 운영 배포 없음';
}

export function buildInsightPrompt({ report, previous, errors, deploys }) {
  return [
    '너는 MODY 팀의 데이터 분석 보조다. 아래 일간 리포트를 읽고 팀이 알아야 할 인사이트를 Slack thread 댓글로 쓴다.',
    '',
    '규칙',
    '- 아래 제공된 숫자만 근거로 쓴다. 없는 숫자를 만들지 않는다.',
    '- 평소와 다른 변화만 고른다. 리포트의 전일 대비와 이전 리포트들을 함께 본다.',
    `- 비교할 이전 리포트는 ${previous.length}개다. 3개 미만이면 비교가 제한적이라고 한 줄로 밝힌다.`,
    '- 1~2건 수준의 작은 변화에는 의미를 부여하지 않는다.',
    '- 원인은 단정하지 않는다. 같은 기간의 에러·배포 기록과 시기가 겹칠 때만 가능성으로 적는다.',
    '- 지표 정의가 필요하면 scripts/daily-report/daily_report.py를 읽는다. 코드·DB·서버는 수정하거나 조회하지 않는다.',
    '- 코드, SQL, 파일 경로, 서버 정보는 쓰지 않는다. 비개발자도 이해할 수 있게 쓴다.',
    '',
    '형식 (600자 이내, 제목 없이 본문만)',
    '- 눈에 띄는 변화 2~3개: 지표와 숫자, 평소와 무엇이 다른지',
    '- 원인 후보: 근거가 있을 때만, 가능성으로',
    '- 확인해 볼 것: 1~2개',
    '- 특이사항이 없으면 "특이사항 없음"과 이유 한 줄만 쓴다.',
    '',
    `[${report.date} 리포트]`,
    report.text,
    '',
    '[이전 리포트]',
    previous.length > 0 ? previous.map((item) => `(${item.date})\n${item.text}`).join('\n\n') : '없음',
    '',
    `[${report.date} 서버 에러 알림]`,
    errors,
    '',
    `[${addDays(report.date, -1)} ~ ${report.date} 운영 배포]`,
    deploys,
  ].join('\n');
}

export function createDailyInsightRunner({
  client,
  botId,
  reportChannelId,
  errorChannelId,
  githubRepo,
  ghPath,
  parseServerError,
  isIgnoredNoise,
  alertEnvironment,
  analyze,
  post,
  format = (text) => text,
  runGh = (args) => execFileAsync(ghPath, args, { timeout: 30_000 }),
  deployWorkflow = 'deploy-prod.yml',
  lookback = 7,
}) {
  async function loadErrors(date) {
    const { start, end } = kstDayRange(date);
    const messages = [];
    let cursor;
    do {
      const response = await client.conversations.history({
        channel: errorChannelId,
        oldest: String(start),
        latest: String(end),
        inclusive: true,
        limit: 200,
        cursor,
      });
      messages.push(...(response.messages ?? []));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor && messages.length < 1000);
    return summarizeErrorAlerts(messages, { parseServerError, isIgnoredNoise, alertEnvironment });
  }

  // 머지 커밋 제목('Merge pull request #n …') 대신 PR 제목을 쓴다.
  async function withPullRequestTitle(run) {
    const number = run.displayTitle?.match(/^Merge pull request #(\d+)/)?.[1];
    if (!number) return run;
    try {
      const { stdout } = await runGh(['pr', 'view', number, '--repo', githubRepo, '--json', 'title', '-q', '.title']);
      return { ...run, displayTitle: `#${number} ${stdout.trim()}` };
    } catch {
      return run;
    }
  }

  async function loadDeploys(date) {
    const window = { since: kstDayRange(addDays(date, -1)).start * 1000, until: kstDayRange(date).end * 1000 };
    try {
      const { stdout } = await runGh([
        'run', 'list', '--repo', githubRepo, '--workflow', deployWorkflow, '--limit', '30',
        '--json', 'createdAt,conclusion,status,displayTitle',
      ]);
      const runs = JSON.parse(stdout).filter((run) => {
        const at = Date.parse(run.createdAt);
        return at >= window.since && at < window.until;
      });
      return summarizeDeploys(await Promise.all(runs.map(withPullRequestTitle)), window);
    } catch (error) {
      console.error('[daily-insight] failed to read deploy runs:', error?.stderr ?? error?.message ?? error);
      return '배포 기록을 가져오지 못함';
    }
  }

  return async function runFor(date, { dryRun = false } = {}) {
    const history = await client.conversations.history({ channel: reportChannelId, limit: 100 });
    const reports = pickReports(history.messages ?? []);
    const report = reports.find((item) => item.date === date);
    if (!report) return { status: 'not_found' };

    if (!dryRun) {
      const replies = await client.conversations.replies({ channel: reportChannelId, ts: report.ts, limit: 100 });
      const posted = (replies.messages ?? []).some((message) => message.ts !== report.ts
        && message.bot_id === botId
        && message.text?.includes(INSIGHT_TITLE));
      if (posted) return { status: 'already_posted' };
    }

    const previous = reports.filter((item) => item.date < date).slice(0, lookback);
    const [errors, deploys] = await Promise.all([loadErrors(date), loadDeploys(date)]);
    const prompt = buildInsightPrompt({ report, previous, errors, deploys });
    const analysis = await analyze(prompt);
    if (!analysis) throw new Error('insight_analysis_failed');

    const text = `*${INSIGHT_TITLE}*\n${format(analysis)}`;
    if (dryRun) return { status: 'dry_run', text, prompt };
    await post(reportChannelId, report.ts, text);
    return { status: 'posted', text };
  };
}

// 리포트 시각 이후 5분마다 확인하고, 어제 날짜 리포트가 올라와 있으면 한 번 분석한다.
// 실패하면 30분 뒤 다시 시도하고, 같은 날짜는 3번까지만 시도한다.
export function startDailyInsight({ time, stateFile, runFor, checkIntervalMs = 5 * 60_000 }) {
  let running = false;
  let lastFailureAt = 0;
  const failures = new Map();

  const tick = async () => {
    if (running) return;
    const date = dueReportDate(Date.now(), time, await readState(stateFile));
    if (!date || (failures.get(date) ?? 0) >= 3) return;
    if (Date.now() - lastFailureAt < 30 * 60_000) return;

    running = true;
    try {
      const result = await runFor(date);
      if (result.status === 'posted' || result.status === 'already_posted') {
        await writeState(stateFile, { lastReportDate: date, status: result.status, at: new Date().toISOString() });
        console.log(`[daily-insight] ${result.status} for ${date}`);
      }
    } catch (error) {
      lastFailureAt = Date.now();
      failures.set(date, (failures.get(date) ?? 0) + 1);
      console.error(`[daily-insight] failed for ${date}:`, error?.data?.error ?? error?.message ?? error);
    } finally {
      running = false;
    }
  };

  tick();
  return setInterval(tick, checkIntervalMs);
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
