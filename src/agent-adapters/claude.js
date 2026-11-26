// Claude Code CLI(claude) 어댑터.

export function buildClaudeArgs({
  prompt,
  model = '',
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
  if (schemaPath) {
    args.push('--json-schema', schemaPath);
  }
  if (settings) {
    args.push('--settings', settings);
  }
  for (const dir of addDirs) {
    args.push('--add-dir', dir);
  }
  args.push('-p', prompt);
  return args;
}

// claude --output-format json 출력에서 최종 답변을 꺼낸다. 실패하면 빈 문자열.
export function parseClaudeOutput(stdout = '') {
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object' || parsed.is_error === true) {
    return '';
  }
  if (parsed.structured_output && typeof parsed.structured_output === 'object') {
    return JSON.stringify(parsed.structured_output);
  }
  if (typeof parsed.result === 'string') {
    return parsed.result.trim();
  }
  return '';
}

export const claudeAdapter = {
  name: 'claude',
  capabilities: {
    schema: true,
    denySettings: true,
    readOnlySandbox: false,
  },
  resolveBin(config = {}) {
    return config.claudePath || 'claude';
  },
  buildArgs(opts) {
    return buildClaudeArgs(opts);
  },
  parseOutput(stdout) {
    return parseClaudeOutput(stdout);
  },
};
