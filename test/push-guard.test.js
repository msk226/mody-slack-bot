import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePushDraft,
  formatPushReviewReport,
  hashAnnouncementCopy,
} from '../src/push-guard.js';

const NOW_MS = new Date('2026-11-25T14:00:00+09:00').getTime();

const BASE_DRAFT = {
  title: '댓글 기능이 열렸어요!',
  content: '최신 버전으로 업데이트하고 친구 기록에 댓글과 이모지를 남겨보세요.',
  targetType: 'ACTIVE_7D',
  scheduledAtKst: '2026-11-25T19:00:00+09:00',
  deepLink: '/home',
  copyChecks: { hasTypo: false, hasAdRisk: false, mentionsAppUpdate: true, notes: [] },
  assumptions: [],
  needsClarification: [],
};

const BASE_CTX = {
  recentAnnouncements: [],
  scheduledAnnouncements: [],
  reminderPeakMinutes: [12 * 60, 18 * 60, 21 * 60],
  audienceStats: {
    ALL: { memberCount: 306, tokenCount: 280, inactive30dRatio: 0.72 },
    ACTIVE_7D: { memberCount: 47, tokenCount: 45, inactive30dRatio: 0 },
  },
};

test('정상 초안은 PASS를 반환한다', () => {
  const res = evaluatePushDraft(BASE_DRAFT, BASE_CTX, NOW_MS);
  assert.equal(res.status, 'PASS');
  assert.equal(res.blocks.length, 0);
  assert.equal(res.warnings.length, 0);
});

test('야간 시간대(21:00~08:00 KST) 발송은 BLOCK한다', () => {
  const nightDraft = { ...BASE_DRAFT, scheduledAtKst: '2026-11-25T22:30:00+09:00' };
  const res = evaluatePushDraft(nightDraft, BASE_CTX, NOW_MS);
  assert.equal(res.status, 'BLOCK');
  assert.ok(res.blocks.some((b) => b.code === 'NIGHT_QUIET_HOURS'));
});

test('리마인더 피크 시간(18:00)과 15분 이내 겹치면 WARN과 30분 이동 대안을 제시한다', () => {
  const collisionDraft = { ...BASE_DRAFT, scheduledAtKst: '2026-11-25T18:10:00+09:00' };
  const res = evaluatePushDraft(collisionDraft, BASE_CTX, NOW_MS);
  assert.equal(res.status, 'WARN');
  assert.ok(res.warnings.some((w) => w.code === 'REMINDER_COLLISION'));
  assert.equal(res.suggestedTimeKst, '18:40');
});

test('최근 24시간 내 동일 제목·본문 재요청은 BLOCK한다', () => {
  const ctx = {
    ...BASE_CTX,
    recentAnnouncements: [
      { title: BASE_DRAFT.title, content: BASE_DRAFT.content, createdAt: '2026-11-25T10:00:00+09:00' },
    ],
  };
  const res = evaluatePushDraft(BASE_DRAFT, ctx, NOW_MS);
  assert.equal(res.status, 'BLOCK');
  assert.ok(res.blocks.some((b) => b.code === 'DUPLICATE_COPY_24H'));
  assert.equal(hashAnnouncementCopy(BASE_DRAFT.title, BASE_DRAFT.content).length, 16);
});

test('최근 7일 내 2회 이상 발송 이력이 있으면 피로도 WARN을 반환한다', () => {
  const ctx = {
    ...BASE_CTX,
    recentAnnouncements: [
      { title: '공지 A', content: '내용 A', createdAt: '2026-11-21T18:00:00+09:00' },
      { title: '공지 B', content: '내용 B', createdAt: '2026-11-23T18:00:00+09:00' },
    ],
  };
  const res = evaluatePushDraft(BASE_DRAFT, ctx, NOW_MS);
  assert.equal(res.status, 'WARN');
  assert.ok(res.warnings.some((w) => w.code === 'FATIGUE_7D'));
});

test('허용되지 않은 외부 URL 딥링크는 BLOCK한다', () => {
  const badLink = { ...BASE_DRAFT, deepLink: 'https://evil.example.com/phish' };
  const res = evaluatePushDraft(badLink, BASE_CTX, NOW_MS);
  assert.equal(res.status, 'BLOCK');
  assert.ok(res.blocks.some((b) => b.code === 'INVALID_DEEPLINK'));
});

test('ALL 타겟에서 최근 30일 미활동 비율이 50% 이상이면 활성 타겟 권고 WARN을 반환한다', () => {
  const allDraft = { ...BASE_DRAFT, targetType: 'ALL' };
  const res = evaluatePushDraft(allDraft, BASE_CTX, NOW_MS);
  assert.equal(res.status, 'WARN');
  assert.ok(res.warnings.some((w) => w.code === 'HIGH_INACTIVE_RATIO'));
});

test('슬랙 리포트 포맷터는 차단/주의 항목과 최종 승인 안내를 포함한다', () => {
  const res = evaluatePushDraft({ ...BASE_DRAFT, targetType: 'ALL' }, BASE_CTX, NOW_MS);
  const report = formatPushReviewReport({ ...BASE_DRAFT, targetType: 'ALL' }, res);
  assert.match(report, /주의 필요 \(WARN\)/);
  assert.match(report, /회원 306명/);
  assert.match(report, /HIGH_INACTIVE_RATIO/);
  assert.match(report, /운영 콘솔/);
});
