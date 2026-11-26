// OpenAI Codex CLI(codex) 어댑터.
// readOnly 또는 permissions.deny 설정이 넘어오면 --sandbox read-only를 강제한다.

export function buildCodexArgs({
  prompt,
  model = '',
  schemaPath = '',
  addDirs = [],
  settings = '',
  readOnly = false,
}) {
  const args = ['exec', '--skip-git-repo-check'];
  const sandboxMode = readOnly || Boolean(settings) ? 'read-only' : 'workspace-write';
  args.push('--sandbox', sandboxMode);
  if (model) {
    args.push('--model', model);
  }
  if (schemaPath) {
    args.push('--output-schema', schemaPath);
  }
  for (const dir of addDirs) {
    args.push('--add-dir', dir);
  }
  args.push(prompt);
  return args;
}

// codex exec 출력(순수 텍스트 또는 JSON)에서 최종 답변을 꺼낸다.
export function parseCodexOutput(stdout = '') {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      if (parsed.error) return '';
      if (typeof parsed.response === 'string') return parsed.response.trim();
      if (typeof parsed.result === 'string') return parsed.result.trim();
      return JSON.stringify(parsed);
    }
  } catch {
    // 일반 텍스트 출력은 그대로 반환
  }
  return trimmed;
}

export const codexAdapter = {
  name: 'codex',
  capabilities: {
    schema: true,
    denySettings: false,
    readOnlySandbox: true,
  },
  resolveBin(config = {}) {
    return config.codexPath || 'codex';
  },
  buildArgs(opts) {
    return buildCodexArgs(opts);
  },
  parseOutput(stdout) {
    return parseCodexOutput(stdout);
  },
};
