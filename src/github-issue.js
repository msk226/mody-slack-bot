import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// 같은 에러(메서드·경로·예외·첫 스택 프레임)는 같은 이슈로 묶는다.
// 이슈 본문에 숨은 표식을 남기고, 열린 이슈 중 표식이 같은 게 있으면 새로 만들지 않는다.
const MARKER_PREFIX = 'mody-error:';

export function errorIssueKey(fingerprint) {
  return createHash('sha1').update(fingerprint).digest('hex').slice(0, 12);
}

/**
 * 에러에 대한 GitHub 이슈를 보장한다.
 * @returns {{status: 'created'|'exists', number: number, url: string} | null}
 */
export async function ensureErrorIssue({ repo, ghPath, labels, cacheFile, fingerprint, error, environment, analysisText, slackLink }) {
  const key = errorIssueKey(fingerprint);

  // 1) 로컬 캐시: GitHub 검색 인덱싱이 늦어도 방금 만든 이슈를 다시 만들지 않는다.
  const cache = await readCache(cacheFile);
  const cached = cache[key];
  if (cached && await isOpen(ghPath, repo, cached.number)) {
    return { status: 'exists', ...cached };
  }

  // 2) 열린 이슈 중 같은 표식이 있으면 그걸 쓴다.
  const found = await findOpenIssue(ghPath, repo, key);
  if (found) {
    await writeCache(cacheFile, { ...cache, [key]: found });
    return { status: 'exists', ...found };
  }

  // 3) 없으면 새로 만든다.
  const created = await createIssue(ghPath, repo, labels, {
    title: issueTitle(error, environment),
    body: issueBody({ key, error, environment, analysisText, slackLink }),
  });
  await writeCache(cacheFile, { ...cache, [key]: created });
  return { status: 'created', ...created };
}

async function findOpenIssue(ghPath, repo, key) {
  const { stdout } = await execFileAsync(ghPath, [
    'issue', 'list', '--repo', repo, '--state', 'open',
    '--search', `"${MARKER_PREFIX}${key}" in:body`,
    '--json', 'number,url', '--limit', '1',
  ], { timeout: 30_000 });
  const [issue] = JSON.parse(stdout || '[]');
  return issue ? { number: issue.number, url: issue.url } : null;
}

async function isOpen(ghPath, repo, number) {
  try {
    const { stdout } = await execFileAsync(ghPath, [
      'issue', 'view', String(number), '--repo', repo, '--json', 'state', '-q', '.state',
    ], { timeout: 30_000 });
    return stdout.trim() === 'OPEN';
  } catch {
    return false;
  }
}

async function createIssue(ghPath, repo, labels, { title, body }) {
  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'];
  for (const label of labels) {
    args.push('--label', label);
  }
  const child = execFileAsync(ghPath, args, { timeout: 30_000 });
  child.child.stdin.end(body);
  const { stdout } = await child;
  const url = stdout.trim().split('\n').at(-1);
  return { number: Number(url.split('/').at(-1)), url };
}

function issueTitle(error, environment) {
  const exception = error.exception?.split('.').at(-1) ?? 'Error';
  const where = [error.method, error.path].filter(Boolean).join(' ');
  const env = environment === 'dev' ? '[dev] ' : '';
  return `${env}${exception}${where ? ` - ${where}` : ''}`.slice(0, 200);
}

function issueBody({ key, error, environment, analysisText, slackLink }) {
  const firstFrame = error.stack.split('\n').map((line) => line.trim()).find(Boolean) ?? '-';
  return [
    '## 작업 유형',
    'bug',
    '',
    '## 배경과 목표',
    `${environment === 'dev' ? '개발' : '운영'} 서버에서 오류가 발생해 Slack 오류 알림으로 자동 등록했다.`,
    '',
    '| 항목 | 값 |',
    '| --- | --- |',
    `| 환경 | ${environment ?? 'unknown'} |`,
    `| 상태 코드 | ${error.status} |`,
    `| 요청 | \`${error.request}\` |`,
    `| 예외 | \`${error.exception}\` |`,
    `| 메시지 | ${error.message ? error.message.replace(/\|/g, '\\|').slice(0, 300) : '-'} |`,
    `| 첫 스택 프레임 | \`${firstFrame.slice(0, 200)}\` |`,
    '',
    '## 자동 분석',
    analysisText ? analysisText.slice(0, 6000) : '_분석 결과 없음_',
    '',
    '## 작업 범위',
    '- [ ] 원인 확인',
    '- [ ] 수정 및 재발 방지',
    '',
    '## 참고 / 결정 필요',
    slackLink ? `- Slack 알림: ${slackLink}` : '- Slack 알림 링크 없음',
    '- 같은 오류가 다시 나도 이 이슈가 열려 있는 동안은 새 이슈를 만들지 않는다.',
    '',
    `<!-- ${MARKER_PREFIX}${key} -->`,
  ].join('\n');
}

async function readCache(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

async function writeCache(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}
