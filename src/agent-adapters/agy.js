// Antigravity CLI(agy) 어댑터.

import os from 'node:os';
import path from 'node:path';

export function buildAgyArgs({
  prompt,
  model = '',
  effort = '',
  timeoutMs = 0,
  schemaPath = '',
  addDirs = [],
  settings = '',
}) {
  const args = [
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ];
  if (model) {
    args.push('--model', model);
  }
  if (effort) {
    args.push('--effort', effort);
  }
  if (timeoutMs > 0) {
    args.push('--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`);
  }
  if (schemaPath) {
    args.push('--json-schema', schemaPath);
  }
  if (settings) {
    // 이번 실행에만 쓰는 설정. 의도별 금지 명령(permissions.deny)을 넘긴다.
    args.push('--settings', settings);
  }
  for (const dir of addDirs) {
    args.push('--add-dir', dir);
  }
  // -p/--print는 바로 뒤 인자를 프롬프트로 받으므로 '=' 형태로 붙여 마지막에 둔다.
  args.push(`--print=${prompt}`);
  return args;
}

// agy --output-format json 결과에서 최종 답변을 꺼낸다. 실패하면 빈 문자열.
export function parseAgyOutput(stdout = '') {
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object' || parsed.status !== 'SUCCESS') {
    return '';
  }
  if (parsed.structured_output && typeof parsed.structured_output === 'object') {
    return JSON.stringify(parsed.structured_output);
  }
  return typeof parsed.response === 'string' ? parsed.response.trim() : '';
}

export const agyAdapter = {
  name: 'agy',
  capabilities: {
    schema: true,
    denySettings: true,
    readOnlySandbox: false,
  },
  resolveBin(config = {}) {
    return config.agyPath || path.join(os.homedir(), '.local', 'bin', 'agy');
  },
  buildArgs(opts) {
    return buildAgyArgs(opts);
  },
  parseOutput(stdout) {
    return parseAgyOutput(stdout);
  },
};
