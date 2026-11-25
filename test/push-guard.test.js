import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePushDraft,
  formatPushReviewReport,
  hashAnnouncementCopy,
  parseKstDate,
} from '../src/push-guard.js';
import {
  buildAudienceSql,
  buildGroupAudienceSql,
  buildRecentAnnouncementsSql,
  buildReminderPeakSql,
  loadPushDbContext,
} from '../src/push-db-context.js';

const NOW_MS = new Date('2026-11-25T14:00:00+09:00').getTime(); // 수요일 14시

const BASE_DRAFT = {
  title: '댓글 기능이 열렸어요!',
  content: '최신 버전으로 업데이트하고 친구 기록에 댓글과 이모지를 남겨보세요.',
  targetType: 'GROUP',
  groupId: '42',
  memberIds: [],
  scheduledAtKst: '2026-11-25T19:30:00+09:00',
  allowQuietHours: false,
  deepLink: null,
  copyChecks: { hasTypo: false, hasAdRisk: false, mentionsAppUpdate: true, notes: [] },
  assumptions: [],
  needsClarification: [],
};

const BASE_CTX = {
  recentAnnouncements: [],
  scheduledAnnouncements: [],
  reminderPeakMinutes: [12 * 60, 18 * 60, 20 * 60],
  audienceStats: {
    ALL: { memberCount: 316, tokenCount: 108, active7dMembers: 47, active30dMembers: 88, inactive30dRatio: 0.72 },
    GROUP: { memberCount: 6, tokenCount: 8 },
  },
};

const codes = (items) => items.map((item) => item.code);

test('정상 초안은 PASS를 반환한다', () => {
  const res = evaluatePushDraft(BASE_DRAFT, BASE_CTX, NOW_MS);
  assert.equal(res.status, 'PASS', JSON.stringify(res));
  assert.ok(res.infos.some((info) => info.includes('회원 6명 / 수신 가능한 기기 8대')));
});

test('서버 공지 API에 없는 대상과 잘못된 GROUP·MEMBERS는 BLOCK한다', () => {
  for (const draft of [
    { ...BASE_DRAFT, targetType: 'ACTIVE_7D' },
    { ...BASE_DRAFT, targetType: 'GROUP', groupId: null },
    { ...BASE_DRAFT, targetType: 'MEMBERS', memberIds: [] },
    { ...BASE_DRAFT, targetType: 'MEMBERS', memberIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) },
  ]) {
    const res = evaluatePushDraft(draft, BASE_CTX, NOW_MS);
    assert.equal(res.status, 'BLOCK', draft.targetType);
    assert.deepEqual(codes(res.blocks), ['INVALID_DRAFT']);
  }
});

test('제목 50자·본문 200자를 넘으면 API가 거절하므로 BLOCK한다', () => {
  const res = evaluatePushDraft({ ...BASE_DRAFT, title: '가'.repeat(51), content: '나'.repeat(201) }, BASE_CTX, NOW_MS);
  assert.deepEqual(codes(res.blocks), ['TITLE_TOO_LONG', 'CONTENT_TOO_LONG']);
  const lockscreen = evaluatePushDraft({ ...BASE_DRAFT, title: '가'.repeat(30) }, BASE_CTX, NOW_MS);
  assert.equal(lockscreen.status, 'WARN');
  assert.deepEqual(codes(lockscreen.warnings), ['TITLE_LOCKSCREEN']);
});

test('야간 발송은 BLOCK하고, 야간 발송 허용을 명시하면 WARN으로 낮춘다', () => {
  const night = { ...BASE_DRAFT, scheduledAtKst: '2026-11-25T22:30:00+09:00' };
  assert.ok(codes(evaluatePushDraft(night, BASE_CTX, NOW_MS).blocks).includes('NIGHT_QUIET_HOURS'));
  const allowed = evaluatePushDraft({ ...night, allowQuietHours: true }, BASE_CTX, NOW_MS);
  assert.equal(allowed.status, 'WARN');
  assert.ok(codes(allowed.warnings).includes('QUIET_HOURS_ALLOWED'));
});

test('시각이 없으면 지금 보낸다고 보고 야간을 판정한다', () => {
  const nowNight = new Date('2026-11-25T23:10:00+09:00').getTime();
  const res = evaluatePushDraft({ ...BASE_DRAFT, scheduledAtKst: null }, BASE_CTX, nowNight);
  assert.ok(codes(res.blocks).includes('NIGHT_QUIET_HOURS'));
  assert.ok(res.infos.some((info) => info.includes('지금 바로 보낸다고')));
});

test('리마인더 집중 시각과 15분 이내로 겹치면 WARN과 30분 옮긴 시각을 제안한다', () => {
  const res = evaluatePushDraft({ ...BASE_DRAFT, scheduledAtKst: '2026-11-25T18:10:00+09:00' }, BASE_CTX, NOW_MS);
  assert.equal(res.status, 'WARN');
  assert.ok(codes(res.warnings).includes('REMINDER_COLLISION'));
  assert.equal(res.suggestedTimeKst, '18:40');
});

test('최근 24시간 안 같은 제목·본문은 BLOCK한다 (DB 시각 문자열도 KST로 읽는다)', () => {
  const ctx = {
    ...BASE_CTX,
    recentAnnouncements: [{ title: BASE_DRAFT.title, content: BASE_DRAFT.content, createdAt: '2026-11-25 10:00:00.123456' }],
  };
  const res = evaluatePushDraft(BASE_DRAFT, ctx, NOW_MS);
  assert.ok(codes(res.blocks).includes('DUPLICATE_COPY_24H'));
  assert.equal(hashAnnouncementCopy(BASE_DRAFT.title, BASE_DRAFT.content).length, 16);
  assert.equal(parseKstDate('2026-11-25 10:00:00').epochMs, Date.parse('2026-11-25T01:00:00Z'));
});

test('최근 7일 2회 이상 발송 이력이 있으면 피로도 WARN을 반환한다', () => {
  const ctx = {
    ...BASE_CTX,
    recentAnnouncements: [
      { title: '공지 A', content: '내용 A', createdAt: '2026-11-21T18:00:00+09:00' },
      { title: '공지 B', content: '내용 B', createdAt: '2026-11-23T18:00:00+09:00' },
    ],
  };
  assert.ok(codes(evaluatePushDraft(BASE_DRAFT, ctx, NOW_MS).warnings).includes('FATIGUE_7D'));
});

test('앱에 없는 경로·외부 URL은 BLOCK하고, 허용 경로는 공지에 적용되지 않는다고 WARN한다', () => {
  for (const link of ['https://evil.example.com/phish', '/groups/123', '/settings']) {
    assert.ok(codes(evaluatePushDraft({ ...BASE_DRAFT, deepLink: link }, BASE_CTX, NOW_MS).blocks)
      .includes('INVALID_DEEPLINK'), link);
  }
  for (const link of ['/home', '/groups/42/home', '/records/meal', '/challenges?tab=weekly']) {
    const res = evaluatePushDraft({ ...BASE_DRAFT, deepLink: link }, BASE_CTX, NOW_MS);
    assert.deepEqual(codes(res.warnings), ['DEEPLINK_NOT_SUPPORTED'], link);
  }
});

test('ALL 대상에서 30일 미활동 비율이 50% 이상이면 콘솔에 있는 선택지로 권고한다', () => {
  const res = evaluatePushDraft({ ...BASE_DRAFT, targetType: 'ALL' }, BASE_CTX, NOW_MS);
  const warning = res.warnings.find((w) => w.code === 'HIGH_INACTIVE_RATIO');
  assert.ok(warning);
  assert.match(warning.message, /72%/);
  assert.doesNotMatch(warning.message, /ACTIVE_7D/);
});

test('리포트는 초안 문구의 Slack 제어 문자를 바꿔 전체 호출을 막는다', () => {
  const draft = { ...BASE_DRAFT, targetType: 'ALL', title: '<!channel> 공지', content: '<@U123> & <https://x|y>' };
  const report = formatPushReviewReport(draft, evaluatePushDraft(draft, BASE_CTX, NOW_MS));
  assert.doesNotMatch(report, /<!channel>|<@U123>|<https:/);
  assert.match(report, /&lt;!channel&gt; 공지/);
  assert.match(report, /&amp;/);
  assert.match(report, /운영 콘솔/);
});

test('DB 조회는 서버와 같은 기준을 쓴다', () => {
  const recent = buildRecentAnnouncementsSql(NOW_MS);
  assert.match(recent, /send_status <> 'FAILED'/);
  assert.match(recent, /created_at >= '2026-11-18 14:00:00'/);
  assert.doesNotMatch(recent, /NOW\(\)/);

  const peaks = buildReminderPeakSql('WEDNESDAY');
  assert.match(peaks, /FROM exercise_schedule es/);
  assert.match(peaks, /es\.day_of_week = 'WEDNESDAY'/);
  assert.match(peaks, /exercise_reminder_enabled = 1/);
  assert.doesNotMatch(peaks, /exercise_time/);
  assert.throws(() => buildReminderPeakSql("MONDAY' OR '1'='1"));

  assert.match(buildAudienceSql(NOW_MS), /enabled = 1 AND status = 'ACTIVE'/);
  assert.match(buildGroupAudienceSql('42'), /gm\.group_member_status = 'JOINED'/);
  assert.throws(() => buildGroupAudienceSql('1 OR 1=1'));
});

test('컨텍스트 로더는 발송 요일로 리마인더를 읽고 GROUP 모수를 붙인다', async () => {
  const seen = [];
  const runQuery = async (sql) => {
    seen.push(sql);
    if (sql.includes('FROM admin_announcement')) return { rows: [['공지', '내용', 'ALL', '2026-11-24T10:00:00+09:00']] };
    if (sql.includes('min_of_day')) return { rows: [['1080', '40']] };
    if (sql.includes('group_members')) return { rows: [['6', '8']] };
    return { rows: [['316', '108', '47', '88']] };
  };
  const ctx = await loadPushDbContext({ draft: { ...BASE_DRAFT, scheduledAtKst: '2026-11-27T19:30:00+09:00' }, nowMs: NOW_MS, runQuery });

  assert.ok(seen.some((sql) => sql.includes("day_of_week = 'FRIDAY'")));
  assert.deepEqual(ctx.reminderPeakMinutes, [1080]);
  assert.equal(ctx.recentAnnouncements[0].createdAt, '2026-11-24T10:00:00+09:00');
  assert.deepEqual(ctx.audienceStats.GROUP, { memberCount: 6, tokenCount: 8 });
  assert.equal(ctx.audienceStats.ALL.tokenCount, 108);
  assert.equal(Math.round(ctx.audienceStats.ALL.inactive30dRatio * 100), 72);
});

test('푸시 모듈에는 발송 경로가 없다 (FCM·공지 발송 API·HTTP 호출 금지)', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['src/push-guard.js', 'src/push-db-context.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|node:https?|firebase|fcm|\/admin\/announcements|chat\.postMessage/i, file);
  }
});
