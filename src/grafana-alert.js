// Grafana 알럿 메시지 해석과 원인 분석 결과 렌더링.
// Grafana Slack 메시지는 text가 비어 있고 내용이 attachments에 들어 있다.

const ALERT_TITLE = /^\[(FIRING|RESOLVED)(?::(\d+))?\]\s*/;
const MAX_LIST_ITEMS = 6;
const MAX_BODY_LENGTH = 2700;

// Slack 메시지에서 사람이 읽는 텍스트를 모두 모은다. text, attachments, blocks 순서.
export function messageText(message = {}) {
  const parts = [];
  if (message.text) {
    parts.push(message.text);
  }
  for (const attachment of message.attachments ?? []) {
    if (attachment.pretext) parts.push(attachment.pretext);
    if (attachment.title) parts.push(attachment.title);
    if (attachment.text) parts.push(attachment.text);
    for (const field of attachment.fields ?? []) {
      parts.push(`${field.title ?? ''}: ${field.value ?? ''}`.trim());
    }
    if (!attachment.title && !attachment.text && attachment.fallback) {
      parts.push(attachment.fallback);
    }
  }
  if (!message.text) {
    for (const block of message.blocks ?? []) {
      if (block.text?.text) parts.push(block.text.text);
      for (const field of block.fields ?? []) {
        if (field.text) parts.push(field.text);
      }
    }
  }
  return parts.filter(Boolean).join('\n').trim();
}

export function parseGrafanaAlert(message = {}) {
  const attachment = (message.attachments ?? []).find((item) => ALERT_TITLE.test(item.title ?? item.fallback ?? ''));
  if (!attachment) {
    return null;
  }

  const title = (attachment.title ?? attachment.fallback).trim();
  const [, state, count] = title.match(ALERT_TITLE);
  const body = attachment.text ?? '';
  const labels = parseSection(body, 'Labels');
  const annotations = parseSection(body, 'Annotations');
  const sourceUrl = attachment.title_link
    ?? body.match(/Source:\s*<([^>|]+)/)?.[1]
    ?? '';

  return {
    state,
    count: Number(count ?? 1),
    title,
    ruleName: labels.alertname ?? title.replace(ALERT_TITLE, ''),
    ruleUid: sourceUrl.match(/\/alerting\/grafana\/([^/]+)\/view/)?.[1] ?? '',
    labels,
    summary: annotations.summary ?? '',
    values: body.match(/Value:\s*([^\n]+)/)?.[1]?.trim() ?? '',
    firedAt: attachment.ts ? new Date(Number(attachment.ts) * 1000).toISOString() : '',
    sourceUrl,
    raw: body,
  };
}

function parseSection(body, name) {
  const section = body.split(new RegExp(`^${name}:\\s*$`, 'm'))[1] ?? '';
  const result = {};
  for (const line of section.split('\n')) {
    if (/^[A-Z][A-Za-z]+:/.test(line)) {
      break;
    }
    const match = line.match(/^\s*-\s*([^=]+?)\s*=\s*(.*)$/);
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }
  return result;
}

export function alertFingerprint(alert) {
  const labels = Object.entries(alert.labels)
    .filter(([key]) => key !== 'grafana_folder')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return `grafana|${alert.ruleUid || alert.ruleName}|${labels}`;
}

export function buildAlertPrompt({ alert, requestText = '', threadContext = '', requestId, repoPath, skillPath }) {
  const labelLines = Object.entries(alert.labels).map(([key, value]) => `- ${key}: ${value}`);
  return [
    '# MODY 운영 알럿 원인 분석',
    '',
    '너는 MODY 백엔드 운영 담당이다. Grafana가 Slack에 보낸 운영 알럿의 원인을 직접 조사하고, 팀원이 바로 이해할 수 있게 정리한다.',
    '',
    '## 규칙',
    '- Grafana 알럿은 항상 운영(prod) 서버에서 온다. dev 서버는 보지 않는다.',
    `- 서버에 접근하기 전에 ${skillPath} 와 같은 폴더의 references/prod-server.md 를 읽고 그 SSH 절차만 쓴다.`,
    '- 읽기만 한다. 데이터 변경, 재시작, 배포, 알럿 설정 변경, 코드 수정은 하지 않는다.',
    '- 서버 상태가 정상인지만 보고 끝내지 않는다. 알럿이 가리키는 지표(라벨의 uri·status 등)가 왜 튀었는지 근거를 찾는다.',
    '',
    '## 조사 순서',
    '1. 알럿 라벨과 발생 시각을 확인한다.',
    '2. 운영 호스트의 Prometheus로 알럿 시각 전후 30분의 해당 지표를 조회한다. 어떤 API·상태 코드가 얼마나 늘었는지 본다.',
    '3. 운영 호스트의 Loki로 같은 시간대 해당 경로의 WARN/ERROR 로그를 본다. 에러 코드, 메시지, 같은 회원(mid)·그룹 반복 여부, 요청 간격을 확인한다.',
    '4. 최근 7일 같은 패턴이 있었는지 비교한다.',
    '5. 필요하면 운영 DB를 읽기 전용으로 조회해 관련 상태(예: 챌린지 상태, 그룹 상태)를 확인한다.',
    `6. MODY 저장소(${repoPath}) 코드로 서버가 왜 그 응답을 냈는지 확인한다.`,
    '7. 원인이 앱(모바일)인지 서버인지 인프라인지 판단하고, 사용자 영향과 조치를 정한다.',
    '',
    '## 결과 작성',
    '- 해요체로, 항목마다 한 문장씩 짧게 쓴다.',
    '- title: 원인을 한 줄로. 예) "완료된 걸음 수 챌린지에 동기화 반복"',
    '- what: 무슨 일이 있었는지. 시각, 대상 API, 건수, 응답 메시지.',
    '- cause: 확인한 원인과 근거. 이전 발생도 있으면 적는다.',
    '- impact: 서버 장애 여부, 사용자 영향, 영향 범위.',
    '- actions: 남은 조치. 앞에 "*앱:*", "*서버:*", "*인프라:*" 중 하나를 붙인다. 스레드에서 이미 끝난 조치는 "~해 뒀어요"처럼 완료로 적는다.',
    '- notes: 확인하지 못했거나 추정인 내용만. 없으면 빈 배열.',
    '- 로그·지표·DB·코드로 직접 확인한 것만 단정한다. 앱 플랫폼(iOS/Android), 사용자 행동처럼 확인하지 않은 내용은 "~로 보여요"로 쓰거나 notes로 옮긴다.',
    '- 회원 ID·그룹 ID 숫자, SQL, 명령어, 서버 주소, 비밀값은 쓰지 않는다. "한 회원", "같은 그룹"처럼 쓴다. API 경로와 에러 코드는 써도 된다.',
    '- 반드시 제공된 JSON Schema와 일치하는 JSON만 최종 응답으로 출력한다.',
    '',
    '## 이번 실행',
    `- 확인 ID: ${requestId}`,
    `- 알럿 상태: ${alert.state}`,
    `- 알럿 이름: ${alert.ruleName}`,
    `- 발생 시각(UTC): ${alert.firedAt || '알 수 없음'}`,
    `- 값: ${alert.values || '없음'}`,
    `- 요약: ${alert.summary || '없음'}`,
    '- 라벨:',
    ...labelLines,
    '',
    '<slack_request>',
    requestText || '(자동 분석: 사용자 요청 없음)',
    '</slack_request>',
    '',
    '<thread_context>',
    threadContext || '이전 대화 없음',
    '</thread_context>',
  ].join('\n');
}

export function parseAlertAnalysis(value) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.title !== 'string') {
    throw new Error('invalid alert analysis');
  }
  const list = (key) => (Array.isArray(parsed[key]) ? parsed[key].map((item) => String(item).trim()).filter(Boolean) : []);
  return {
    status: parsed.status ?? 'completed',
    title: parsed.title.trim(),
    what: list('what'),
    cause: list('cause'),
    impact: list('impact'),
    actions: list('actions'),
    notes: list('notes'),
  };
}

export function renderAlertAnalysis(result, requestId) {
  const lines = [`:mag_right: *알럿 원인: ${result.title}*`];
  const sections = [
    ['무슨 일인지', result.what],
    ['원인', result.cause],
    ['영향', result.impact],
    ['조치 제안', result.actions],
    ['참고 (확인 필요)', result.notes],
  ];
  for (const [heading, items] of sections) {
    if (items.length === 0) continue;
    lines.push('', `*${heading}*`, ...items.slice(0, MAX_LIST_ITEMS).map((item) => `• ${item}`));
  }

  let body = lines.join('\n');
  if (body.length > MAX_BODY_LENGTH) {
    body = `${body.slice(0, MAX_BODY_LENGTH)}\n...`;
  }
  return `${body}\n\n_확인 ID: ${requestId}_`;
}

export function renderAlertFallback(alert, requestId) {
  const labels = Object.entries(alert.labels)
    .filter(([key]) => !['alertname', 'grafana_folder', 'team'].includes(key))
    .map(([key, value]) => `• ${key}: ${value}`);
  return [
    ':alert-red: *알럿 원인을 자동으로 정리하지 못했어요*',
    `• 알럿: ${alert.ruleName}`,
    ...(alert.summary ? [`• 요약: ${alert.summary}`] : []),
    ...labels,
    '',
    '이 스레드에서 모디 봇을 다시 멘션해 주세요.',
    '',
    `_확인 ID: ${requestId}_`,
  ].join('\n');
}
