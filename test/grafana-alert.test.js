import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alertFingerprint,
  buildAlertPrompt,
  messageText,
  parseAlertAnalysis,
  parseGrafanaAlert,
  renderAlertAnalysis,
} from '../src/grafana-alert.js';

const grafanaMessage = {
  subtype: 'bot_message',
  text: '',
  username: 'Grafana',
  bot_id: 'B0GRAFANA',
  ts: '1794913930.209969',
  attachments: [{
    ts: 1794913930,
    fallback: '[FIRING:1] 서버 에러 (5분간 5xx 3건 이상) MODY 알럿 (server)',
    title: '[FIRING:1] 서버 에러 (5분간 5xx 3건 이상) MODY 알럿 (server)',
    title_link: 'https://example.test/grafana/alerting/grafana/mody-api-5xx/view',
    text: [
      '**Firing**',
      '',
      'Value: A=4, B=4, C=1',
      'Labels:',
      ' - alertname = 서버 에러 (5분간 5xx 3건 이상)',
      ' - grafana_folder = MODY 알럿',
      ' - team = server',
      ' - uri = /api/v1/records',
      'Annotations:',
      ' - summary = 최근 5분 5xx 4건이에요.',
      'Source: <https://example.test/grafana/alerting/grafana/mody-api-5xx/view?orgId=1>',
    ].join('\n'),
  }],
};

test('reads Grafana alert content from attachments', () => {
  const text = messageText(grafanaMessage);
  assert.match(text, /\[FIRING:1\] 서버 에러/);
  assert.match(text, /uri = \/api\/v1\/records/);
});

test('keeps plain message text unchanged', () => {
  assert.equal(messageText({ text: '체크해줘' }), '체크해줘');
});

test('parses firing Grafana alert labels and annotations', () => {
  const alert = parseGrafanaAlert(grafanaMessage);
  assert.equal(alert.state, 'FIRING');
  assert.equal(alert.ruleUid, 'mody-api-5xx');
  assert.equal(alert.ruleName, '서버 에러 (5분간 5xx 3건 이상)');
  assert.equal(alert.labels.uri, '/api/v1/records');
  assert.equal(alert.summary, '최근 5분 5xx 4건이에요.');
  assert.equal(alert.values, 'A=4, B=4, C=1');
});

test('ignores messages that are not Grafana alerts', () => {
  assert.equal(parseGrafanaAlert({ text: '*Status*: 500' }), null);
  assert.equal(parseGrafanaAlert({ attachments: [{ title: '배포 완료' }] }), null);
});

test('detects resolved alerts', () => {
  const resolved = structuredClone(grafanaMessage);
  resolved.attachments[0].title = resolved.attachments[0].title.replace('FIRING', 'RESOLVED');
  assert.equal(parseGrafanaAlert(resolved).state, 'RESOLVED');
});

test('fingerprint ignores folder label and is stable', () => {
  const alert = parseGrafanaAlert(grafanaMessage);
  assert.equal(alertFingerprint(alert), 'grafana|mody-api-5xx|alertname=서버 에러 (5분간 5xx 3건 이상),team=server,uri=/api/v1/records');
});

test('alert prompt pins prod and includes labels and request', () => {
  const prompt = buildAlertPrompt({
    alert: parseGrafanaAlert(grafanaMessage),
    requestText: '체크해줘',
    requestId: 'MODY-1',
    repoPath: '/repo',
    skillPath: '/skills/mody-operations/SKILL.md',
  });
  assert.match(prompt, /운영\(prod\) 서버/);
  assert.match(prompt, /dev 서버는 보지 않는다/);
  assert.match(prompt, /- uri: \/api\/v1\/records/);
  assert.match(prompt, /<slack_request>\n체크해줘/);
});

test('renders analysis in the shared alert format', () => {
  const result = parseAlertAnalysis(JSON.stringify({
    status: 'completed',
    title: '완료된 챌린지에 동기화 반복',
    what: ['7초 동안 404가 25번 났어요'],
    cause: ['챌린지가 완료됐어요'],
    impact: ['서버 장애는 아니에요'],
    actions: ['*앱:* 완료 상태면 보내지 않게 해 주세요'],
    notes: [],
  }));
  const text = renderAlertAnalysis(result, 'MODY-1');
  assert.equal(text, [
    ':mag_right: *알럿 원인: 완료된 챌린지에 동기화 반복*',
    '',
    '*무슨 일인지*',
    '• 7초 동안 404가 25번 났어요',
    '',
    '*원인*',
    '• 챌린지가 완료됐어요',
    '',
    '*영향*',
    '• 서버 장애는 아니에요',
    '',
    '*조치 제안*',
    '• *앱:* 완료 상태면 보내지 않게 해 주세요',
    '',
    '_확인 ID: MODY-1_',
  ].join('\n'));
});
