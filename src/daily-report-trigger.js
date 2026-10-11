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
export function startDailyReportTrigger({ repo, ghPath, workflow, time, stateFile, checkIntervalMs = 60_000 }) {
  const [hour, minute] = time.split(':').map(Number);
  let running = false;
  let lastFailureAt = 0;

  const tick = async () => {
    if (running) return;
    const nowKst = new Date(Date.now() + KST_OFFSET_MS);
    const today = nowKst.toISOString().slice(0, 10);
    const minutesNow = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes();
    if (minutesNow < hour * 60 + minute) return;

    const state = await readState(stateFile);
    if (state.lastTriggeredDate === today) return;
    // 실패하면 10분 뒤에 다시 시도한다.
    if (Date.now() - lastFailureAt < 10 * 60_000) return;

    running = true;
    try {
      await execFileAsync(ghPath, ['workflow', 'run', workflow, '--repo', repo], { timeout: 60_000 });
      await writeState(stateFile, { lastTriggeredDate: today, triggeredAt: new Date().toISOString() });
      console.log(`[daily-report] triggered ${workflow} for ${today}`);
    } catch (error) {
      lastFailureAt = Date.now();
      console.error('[daily-report] failed to trigger workflow:', error?.stderr ?? error);
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
