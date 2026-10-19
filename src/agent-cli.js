// Antigravity CLI(agy) 비대화 실행 인자와 결과 파싱.

export function buildAgyArgs({
  prompt,
  model,
  effort,
  timeoutMs = 0,
  schemaPath = '',
  addDirs = [],
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
