import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 매일 정해진 시각(KST)에 GitHub의 daily-report 워크플로를 실행한다.
// GitHub 예약 실행은 몇 시간씩 늦어서, 정시 트리거는 봇이 맡고 GitHub 예약은 예비로 둔다.
// 맥이 꺼져 있다가 그 시각 이후에 켜지면 켜지는 즉시 한 번 실행한다.
// 리포트 스크립트가 같은 날짜 중복 발송을 막으므로 여기서는 하루 한 번 트리거만 보장한다.
// weekly이면 매주 월요일 그 시각에 한 번 실행한다. 월요일에 맥이 꺼져 있었으면 그 주 안에 켜질 때 실행한다.
export function startDailyReportTrigger({
  repo, ghPath, workflow, time, stateFile, checkIntervalMs = 60_000, weekly = false,
}) {
  let running = false;
  let lastFailureAt = 0;
  const label = weekly ? 'weekly-report' : 'daily-report';

  const tick = async () => {
    if (running) return;
    const period = duePeriod(Date.now(), time, weekly);
    if (!period) return;

    const state = await readState(stateFile);
    if (state.lastTriggeredDate === period) return;
    // 실패하면 10분 뒤에 다시 시도한다.
    if (Date.now() - lastFailureAt < 10 * 60_000) return;

    running = true;
    try {
      await execFileAsync(ghPath, ['workflow', 'run', workflow, '--repo', repo], { timeout: 60_000 });
      await writeState(stateFile, { lastTriggeredDate: period, triggeredAt: new Date().toISOString() });
      console.log(`[${label}] triggered ${workflow} for ${period}`);
    } catch (error) {
      lastFailureAt = Date.now();
      console.error(`[${label}] failed to trigger workflow:`, error?.stderr ?? error);
    } finally {
      running = false;
    }
  };

  tick();
  return setInterval(tick, checkIntervalMs);
}

// 트리거할 기간의 키(KST 날짜). daily는 오늘, weekly는 이번 주 월요일. 아직 시각 전이면 null.
export function duePeriod(nowMs, time, weekly = false) {
  const [hour, minute] = time.split(':').map(Number);
  const nowKst = new Date(nowMs + KST_OFFSET_MS);
  const beforeTime = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes() < hour * 60 + minute;
  const sinceMonday = weekly ? (nowKst.getUTCDay() + 6) % 7 : 0;
  if (sinceMonday === 0 && beforeTime) return null;
  nowKst.setUTCDate(nowKst.getUTCDate() - sinceMonday);
  return nowKst.toISOString().slice(0, 10);
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
