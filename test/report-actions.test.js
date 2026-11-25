import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionPath,
  decideReportAction,
  handleReportAction,
  loadReportActionConfig,
  parseActionValue,
  renderResolvedBlocks,
  signRequest,
} from '../src/report-actions.js';

const NOW = 1_700_000_000_000;
const config = loadReportActionConfig({
  REPORT_ACTIONS_ENABLED: 'true',
  REPORT_ACTION_BASE_URL: 'https://dev.example.com/',
  REPORT_ACTION_SECRET: 'test-secret',
  REPORT_ACTION_CHANNEL_IDS: 'C_REPORT',
});

const alertBlocks = [
  { type: 'header', text: { type: 'plain_text', text: '[dev] 기록 신고' } },
  { type: 'actions', block_id: 'report_actions', elements: [] },
];

function click(actionId = 'report_hide', overrides = {}) {
  return {
    body: { channel: { id: 'C_REPORT' }, user: { id: 'U0TEST' }, message: { blocks: alertBlocks }, ...overrides },
    action: { action_id: actionId, value: 'RECORD:100' },
  };
}

function recorder() {
  const calls = { respond: [], fetch: [], audit: [] };
  return {
    calls,
    respond: async (message) => { calls.respond.push(message); },
    auditLog: { record: async (event) => { calls.audit.push(event); } },
    fetchReturning: (status, body) => async (url, init) => {
      calls.fetch.push({ url, init });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  };
}

test('signature matches the mody-server vector (SlackActionAuthenticatorTest)', () => {
  assert.equal(
    signRequest({
      secret: 'test-secret', timestamp: '1700000000', method: 'POST',
      path: '/api/v1/admin/slack/reports/records/100/hide', slackUserId: 'U0TEST',
    }),
    'v1=c465434c42378debf7b2d699de0fc365de9ddf9a73d9fb93fa529daa8647d38e',
  );
});

test('parses button values and builds server paths', () => {
  assert.deepEqual(parseActionValue('COMMENT:42'), { kind: 'COMMENT', targetId: '42' });
  assert.equal(parseActionValue('RECORD:abc'), null);
  assert.equal(parseActionValue('MEMBER:1'), null);
  assert.equal(actionPath({ kind: 'COMMENT', targetId: '42' }, 'report_dismiss'),
    '/api/v1/admin/slack/reports/comments/42/dismiss');
});

test('disabled, prod, unconfigured and other channels are refused', () => {
  assert.equal(decideReportAction({ config: { ...config, enabled: false }, channelId: 'C_REPORT' }).reason, 'disabled');
  assert.equal(decideReportAction({ config: { ...config, environment: 'prod' }, channelId: 'C_REPORT' }).reason,
    'prod_not_allowed');
  assert.equal(decideReportAction({ config: { ...config, secret: '' }, channelId: 'C_REPORT' }).reason, 'not_configured');
  assert.equal(decideReportAction({ config, channelId: 'C_OTHER' }).reason, 'channel_not_allowed');
  assert.deepEqual(decideReportAction({ config, channelId: 'C_REPORT' }), { allowed: true });
});

test('resolved click calls the server with a signed request and replaces the buttons with the result', async () => {
  const r = recorder();
  const outcome = await handleReportAction({
    ...click(), respond: r.respond, config, auditLog: r.auditLog, now: () => NOW,
    fetchImpl: r.fetchReturning(200, { result: {
      outcome: 'RESOLVED', kind: 'RECORD', targetId: '100', resolution: 'HIDDEN', resolvedBy: 'ops@example.com',
      resolverSlackUserId: 'U0TEST', resolvedAt: '2026-11-25T10:03:21.123', resolvedReports: 2,
    } }),
  });

  assert.equal(outcome.status, 'RESOLVED');
  const [{ url, init }] = r.calls.fetch;
  assert.equal(url, 'https://dev.example.com/api/v1/admin/slack/reports/records/100/hide');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-Slack-User-Id'], 'U0TEST');
  assert.equal(init.headers['X-Slack-Action-Timestamp'], '1700000000');
  assert.equal(init.headers['X-Slack-Action-Signature'],
    'v1=c465434c42378debf7b2d699de0fc365de9ddf9a73d9fb93fa529daa8647d38e');

  const [reply] = r.calls.respond;
  assert.equal(reply.replace_original, true);
  assert.equal(reply.blocks.some((block) => block.type === 'actions'), false);
  assert.match(reply.blocks.at(-1).elements[0].text, /처리됨: 숨김\* · <@U0TEST> · 2026-11-25 10:03/);
  assert.equal(r.calls.audit[0].type, 'report_action');
  assert.equal(r.calls.audit[0].status, 'success');
});

test('already resolved in the console shows who handled it and does not re-process', async () => {
  const r = recorder();
  await handleReportAction({
    ...click('report_dismiss'), respond: r.respond, config, auditLog: r.auditLog, now: () => NOW,
    fetchImpl: r.fetchReturning(200, { result: {
      outcome: 'ALREADY_RESOLVED', kind: 'RECORD', targetId: '100', resolution: 'HIDDEN',
      resolvedBy: 'console@example.com', resolverSlackUserId: null, resolvedAt: '2026-11-25T09:00:00',
      resolvedReports: 0,
    } }),
  });

  const text = r.calls.respond[0].blocks.at(-1).elements[0].text;
  assert.match(text, /이미 처리된 신고입니다: 숨김\* · console@example\.com \(콘솔\) · 2026-11-25 09:00/);
  assert.match(text, /확인: <@U0TEST>/);
  assert.equal(r.calls.audit[0].status, 'already_resolved');
});

test('forbidden (VIEWER or unlinked) is shown only to the clicker and keeps the message', async () => {
  const r = recorder();
  const outcome = await handleReportAction({
    ...click(), respond: r.respond, config, auditLog: r.auditLog, now: () => NOW,
    fetchImpl: r.fetchReturning(403, {}),
  });

  assert.deepEqual(outcome, { status: 'failed', reason: 403 });
  assert.equal(r.calls.respond[0].response_type, 'ephemeral');
  assert.equal(r.calls.respond[0].replace_original, false);
  assert.match(r.calls.respond[0].text, /처리 권한이 없습니다/);
  assert.equal(r.calls.audit[0].errorCode, '403');
});

test('prod alerts are refused before calling the server', async () => {
  const r = recorder();
  const outcome = await handleReportAction({
    ...click(), respond: r.respond, config: { ...config, environment: 'prod' }, auditLog: r.auditLog,
    fetchImpl: r.fetchReturning(200, {}),
  });

  assert.deepEqual(outcome, { status: 'denied', reason: 'prod_not_allowed' });
  assert.equal(r.calls.fetch.length, 0);
});

test('network failure tells the clicker to use the console', async () => {
  const r = recorder();
  const outcome = await handleReportAction({
    ...click(), respond: r.respond, config, auditLog: r.auditLog,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });

  assert.equal(outcome.reason, 'network');
  assert.match(r.calls.respond[0].text, /콘솔에서 처리/);
});

test('renderResolvedBlocks keeps the alert body and drops only the buttons', () => {
  const blocks = renderResolvedBlocks(alertBlocks, {
    outcome: 'RESOLVED', resolution: 'DISMISSED', resolverSlackUserId: 'U1', resolvedAt: '2026-11-25T10:00:00',
  }, 'U1');
  assert.deepEqual(blocks.map((block) => block.type), ['header', 'context']);
});
