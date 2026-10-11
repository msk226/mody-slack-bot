import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSIGHT_TITLE,
  addDays,
  createDailyInsightRunner,
  dueReportDate,
  flattenReportBlocks,
  kstDayRange,
  pickReports,
  summarizeErrorAlerts,
} from '../src/daily-insight.js';

const reportBlocks = [
  { type: 'header', text: { type: 'plain_text', text: '📊 MODY 데일리 리포트' } },
  { type: 'context', elements: [{ type: 'mrkdwn', text: '*2026.10.10 (토)*　·　10/9(금) → 10/10(토)' }] },
  { type: 'divider' },
  {
    type: 'rich_text',
    elements: [
      { type: 'rich_text_section', elements: [{ type: 'text', text: '핵심 지표', style: { bold: true } }] },
      {
        type: 'rich_text_list',
        style: 'bullet',
        indent: 0,
        elements: [{
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: '👥 전체 회원　' },
            { type: 'text', text: '100 → ' },
            { type: 'text', text: '102명', style: { bold: true } },
            { type: 'text', text: '　' },
            { type: 'emoji', name: 'mody-up' },
            { type: 'text', text: ' +2' },
          ],
        }],
      },
      { type: 'rich_text_section', elements: [{ type: 'text', text: '\n' }] },
      {
        type: 'rich_text_list',
        style: 'bullet',
        indent: 1,
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '실패　3건 (1.5%)' }] }],
      },
    ],
  },
  { type: 'divider' },
  { type: 'context', elements: [{ type: 'mrkdwn', text: '💬  보고 싶은 지표가 있으면 스레드에 남겨주세요.' }] },
];

test('flattens report blocks into analysis text', () => {
  assert.equal(flattenReportBlocks(reportBlocks), [
    '📊 MODY 데일리 리포트',
    '*2026.10.10 (토)*　·　10/9(금) → 10/10(토)',
    '핵심 지표',
    '- 👥 전체 회원　100 → 102명　▲ +2',
    '  - 실패　3건 (1.5%)',
  ].join('\n'));
});

test('picks bot reports by date in both title formats, keeping the latest resend', () => {
  const reports = pickReports([
    { ts: '300.0', bot_id: 'B1', text: 'MODY 일일 리포트 2026-10-10', blocks: reportBlocks },
    { ts: '200.0', bot_id: 'B1', text: 'MODY 데일리 리포트 2026-10-09' },
    { ts: '150.0', bot_id: 'B1', text: 'MODY 데일리 리포트 2026-10-09' },
    { ts: '100.0', user: 'U1', text: 'MODY 일일 리포트 2026-10-08' },
  ]);
  assert.deepEqual(reports.map((report) => [report.date, report.ts]), [['2026-10-10', '300.0'], ['2026-10-09', '200.0']]);
  assert.match(reports[0].text, /▲ \+2/);
  assert.equal(reports[1].text, 'MODY 데일리 리포트 2026-10-09');
});

test('analyzes yesterday report only after the report time and once per date', () => {
  assert.equal(dueReportDate(Date.parse('2026-10-11T08:59:00+09:00'), '09:00'), null);
  assert.equal(dueReportDate(Date.parse('2026-10-11T09:05:00+09:00'), '09:00'), '2026-10-10');
  assert.equal(dueReportDate(Date.parse('2026-10-11T09:05:00+09:00'), '09:00', { lastReportDate: '2026-10-10' }), null);
});

test('computes KST day ranges and date offsets', () => {
  const range = kstDayRange('2026-10-10');
  assert.equal(range.start, Date.parse('2026-10-09T15:00:00Z') / 1000);
  assert.equal(range.end - range.start, 86400);
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('summarizes error alerts by environment and request', () => {
  const deps = {
    parseServerError: (text) => (text.startsWith('ERR') ? { method: 'GET', path: text.split(' ')[1], exception: 'NPE' } : null),
    isIgnoredNoise: (error) => error.path === '/favicon.ico',
    alertEnvironment: (text) => (text.includes('prod') ? 'prod' : null),
  };
  assert.equal(summarizeErrorAlerts([
    { text: 'ERR /a prod' },
    { text: 'ERR /a prod' },
    { text: 'ERR /favicon.ico prod' },
    { text: 'hello' },
    { text: 'ERR /b' },
  ], deps), [
    '총 3건 (prod 2건, 환경 미표기 1건)',
    '- prod · GET /a · NPE: 2건',
    '- 환경 미표기 · GET /b · NPE: 1건',
  ].join('\n'));
  assert.equal(summarizeErrorAlerts([], deps), '에러 알림 없음');
});

function fakeClient({ reports = [], replies = [] } = {}) {
  const calls = { replies: 0 };
  return {
    calls,
    conversations: {
      history: async ({ channel }) => ({ messages: channel === 'CREPORT' ? reports : [] }),
      replies: async () => {
        calls.replies += 1;
        return { messages: replies };
      },
    },
  };
}

function runnerDeps(client, overrides = {}) {
  return {
    client,
    botId: 'BBOT',
    reportChannelId: 'CREPORT',
    errorChannelId: 'CERR',
    parseServerError: () => null,
    isIgnoredNoise: () => false,
    alertEnvironment: () => null,
    analyze: async () => '- 특이사항 없음',
    post: async () => {},
    ...overrides,
  };
}

const report = { ts: '300.0', bot_id: 'BBOT', text: 'MODY 일일 리포트 2026-10-10', blocks: reportBlocks };

test('reports not_found until the report is posted', async () => {
  const runFor = createDailyInsightRunner(runnerDeps(fakeClient()));
  assert.deepEqual(await runFor('2026-10-10'), { status: 'not_found' });
});

test('does not post twice when the thread already has an insight', async () => {
  let analyzed = false;
  const client = fakeClient({
    reports: [report],
    replies: [report, { ts: '301.0', bot_id: 'BBOT', text: `*${INSIGHT_TITLE}*\n- 이미 남김` }],
  });
  const runFor = createDailyInsightRunner(runnerDeps(client, { analyze: async () => { analyzed = true; return 'x'; } }));
  assert.deepEqual(await runFor('2026-10-10'), { status: 'already_posted' });
  assert.equal(analyzed, false);
});

test('posts the insight in the report thread with the report and errors in the prompt', async () => {
  let prompt = '';
  const posts = [];
  const client = fakeClient({ reports: [report], replies: [report] });
  const runFor = createDailyInsightRunner(runnerDeps(client, {
    analyze: async (value) => { prompt = value; return '- 회원 증가'; },
    post: async (...args) => { posts.push(args); },
  }));

  const result = await runFor('2026-10-10');
  assert.equal(result.status, 'posted');
  assert.match(prompt, /\[2026-10-10 리포트\]/);
  assert.match(prompt, /▲ \+2/);
  assert.match(prompt, /에러 알림 없음/);
  assert.doesNotMatch(prompt, /배포/);
  assert.deepEqual(posts, [['CREPORT', '300.0', `*${INSIGHT_TITLE}*\n- 회원 증가`]]);
});

test('dry run returns the text without checking the thread or posting', async () => {
  let posted = false;
  const client = fakeClient({ reports: [report] });
  const runFor = createDailyInsightRunner(runnerDeps(client, { post: async () => { posted = true; } }));
  const result = await runFor('2026-10-10', { dryRun: true });
  assert.equal(result.status, 'dry_run');
  assert.equal(client.calls.replies, 0);
  assert.equal(posted, false);
});

test('fails when the analysis returns nothing so the scheduler can retry', async () => {
  const client = fakeClient({ reports: [report], replies: [report] });
  const runFor = createDailyInsightRunner(runnerDeps(client, { analyze: async () => null }));
  await assert.rejects(runFor('2026-10-10'), /insight_analysis_failed/);
});
