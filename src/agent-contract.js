const ENVIRONMENT_LABELS = {
  dev: '개발',
  prod: '운영',
  mixed: '개발·운영',
  local: '로컬 코드',
  none: '해당 없음',
};

export function inferEnvironment(text) {
  const hasProd = /(?:\bprod\b|\bprd\b|운영)/i.test(text);
  const hasDev = /(?:\bdev\b|데브|개발(?:\s*(?:서버|DB|디비|데이터베이스))?)/i.test(text);
  if (hasProd && hasDev) return 'mixed';
  if (hasProd) return 'prod';
  if (hasDev) return 'dev';
  return 'none';
}

export function parseAgentResult(value) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.summary !== 'string') {
    throw new Error('invalid agent result');
  }
  return {
    status: parsed.status ?? 'completed',
    environment: parsed.environment ?? 'none',
    summary: parsed.summary.trim(),
    facts: Array.isArray(parsed.facts) ? parsed.facts : [],
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation.trim() : '',
    actions: Array.isArray(parsed.actions) ? parsed.actions.filter(Boolean) : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter(Boolean) : [],
  };
}

export function renderAgentResult(result, requestId) {
  const lines = [
    result.status === 'failed' ? '*처리 실패*'
      : result.status === 'needs_input' ? '*추가 확인이 필요합니다*'
        : '*처리 결과*',
    result.summary,
  ];

  const facts = result.facts
    .filter((fact) => fact && fact.label && fact.value)
    .slice(0, 12);
  if (result.environment !== 'none' || facts.length > 0) {
    lines.push('', '*확인 결과*');
    if (result.environment !== 'none') {
      lines.push(`• 환경: ${ENVIRONMENT_LABELS[result.environment] ?? result.environment}`);
    }
    for (const fact of facts) {
      lines.push(`• ${fact.label}: ${fact.value}`);
    }
  }

  if (result.explanation) {
    lines.push('', '*판단*', result.explanation);
  }
  if (result.actions.length > 0) {
    lines.push('', result.status === 'needs_input' ? '*필요한 정보*' : '*다음 조치*');
    lines.push(...result.actions.slice(0, 6).map((action) => `• ${action}`));
  }
  if (result.warnings.length > 0) {
    lines.push('', '*참고*');
    lines.push(...result.warnings.slice(0, 4).map((warning) => `• ${warning}`));
  }

  lines.push('', `_확인 ID: ${requestId}_`);
  return lines.join('\n');
}
