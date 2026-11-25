// 푸시 사전 검증에 필요한 운영 DB 읽기 전용 컨텍스트 로더.
// 반드시 src/prod-db/guard.js + runner.js(SELECT 전용 계정, START TRANSACTION READ ONLY + ROLLBACK)만 쓴다.
// 기준은 서버와 같다: 활성 회원, 수신 가능한(enabled) 기기, 실패하지 않은 공지, 실제 리마인더 설정.

import { prepareReadOnlyQuery } from './prod-db/guard.js';
import { loadConfig, runSql } from './prod-db/runner.js';
import { effectiveSendAt } from './push-guard.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAYS = new Set(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']);
const PEAK_MIN_COUNT = 15;

// DB의 DATETIME은 KST로 저장된다. DB 서버 시간대(NOW())에 기대지 않도록 기준 시각을 KST 문자열로 넣는다.
export function kstDateTimeLiteral(epochMs) {
  return new Date(epochMs + KST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

export function buildRecentAnnouncementsSql(nowMs) {
  return `SELECT title, content, target_type, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s+09:00') AS created_at_kst
    FROM admin_announcement
    WHERE created_at >= '${kstDateTimeLiteral(nowMs - 7 * DAY_MS)}' AND send_status <> 'FAILED'
    ORDER BY created_at DESC
    LIMIT 20`;
}

// 식사 리마인더는 notification_setting의 시각, 운동 리마인더는 exercise_schedule(요일별)에서 나간다.
export function buildReminderPeakSql(dayOfWeek) {
  if (!DAYS.has(dayOfWeek)) throw new Error(`요일 값이 올바르지 않습니다: ${dayOfWeek}`);
  const meal = (column) => `SELECT ${column} AS t FROM notification_setting
           WHERE deleted_at IS NULL AND status = 'ACTIVE' AND meal_reminder_enabled = 1 AND ${column} IS NOT NULL`;
  return `SELECT HOUR(t) * 60 + MINUTE(t) AS min_of_day, COUNT(*) AS cnt
    FROM (
      ${meal('breakfast_time')}
      UNION ALL ${meal('lunch_time')}
      UNION ALL ${meal('dinner_time')}
      UNION ALL SELECT es.scheduled_time AS t FROM exercise_schedule es
        JOIN notification_setting ns ON ns.member_id = es.member_id AND ns.deleted_at IS NULL
          AND ns.status = 'ACTIVE' AND ns.exercise_reminder_enabled = 1
        WHERE es.deleted_at IS NULL AND es.day_of_week = '${dayOfWeek}'
    ) x
    GROUP BY min_of_day
    HAVING cnt >= ${PEAK_MIN_COUNT}
    ORDER BY cnt DESC
    LIMIT 10`;
}

const VALID_TOKENS = `SELECT member_id, COUNT(*) AS token_cnt FROM member_push_token
         WHERE enabled = 1 AND status = 'ACTIVE' AND deleted_at IS NULL GROUP BY member_id`;

export function buildAudienceSql(nowMs) {
  const since = (days) => kstDateTimeLiteral(nowMs - days * DAY_MS);
  return `WITH active_7d AS (
      SELECT DISTINCT member_id FROM activity_record
      WHERE deleted_at IS NULL AND status = 'ACTIVE' AND uploaded_at >= '${since(7)}'
    ),
    active_30d AS (
      SELECT DISTINCT member_id FROM activity_record
      WHERE deleted_at IS NULL AND status = 'ACTIVE' AND uploaded_at >= '${since(30)}'
    ),
    valid_tokens AS (${VALID_TOKENS})
    SELECT
      COUNT(DISTINCT m.id) AS all_members,
      COALESCE(SUM(vt.token_cnt), 0) AS all_devices,
      COUNT(DISTINCT a7.member_id) AS active_7d_members,
      COUNT(DISTINCT a30.member_id) AS active_30d_members
    FROM member m
    LEFT JOIN valid_tokens vt ON vt.member_id = m.id
    LEFT JOIN active_7d a7 ON a7.member_id = m.id
    LEFT JOIN active_30d a30 ON a30.member_id = m.id
    WHERE m.deleted_at IS NULL AND m.status = 'ACTIVE'`;
}

// 서버 공지의 GROUP 대상과 같은 조건: 활성 그룹의 JOINED 회원.
export function buildGroupAudienceSql(groupId) {
  if (!/^\d{1,20}$/.test(String(groupId))) throw new Error(`그룹 ID가 올바르지 않습니다: ${groupId}`);
  return `WITH valid_tokens AS (${VALID_TOKENS})
    SELECT COUNT(DISTINCT m.id) AS group_members, COALESCE(SUM(vt.token_cnt), 0) AS group_devices
    FROM mody_group g
    JOIN group_member gm ON gm.group_id = g.id AND gm.group_member_status = 'JOINED'
      AND gm.status = 'ACTIVE' AND gm.deleted_at IS NULL
    JOIN member m ON m.id = gm.member_id AND m.status = 'ACTIVE' AND m.deleted_at IS NULL
    LEFT JOIN valid_tokens vt ON vt.member_id = m.id
    WHERE g.id = ${groupId} AND g.status = 'ACTIVE' AND g.deleted_at IS NULL`;
}

async function defaultRunQuery(rawSql, config) {
  return runSql(prepareReadOnlyQuery(rawSql), config);
}

/**
 * @param {{ draft?: object, nowMs?: number, config?: object, runQuery?: Function }} options
 * 발송 요일(예약 시각 또는 지금)의 운동 리마인더를 보고, GROUP 대상이면 그 그룹의 모수도 읽는다.
 */
export async function loadPushDbContext({
  draft = {}, nowMs = Date.now(), config, runQuery = defaultRunQuery,
} = {}) {
  const dbConfig = config ?? (runQuery === defaultRunQuery ? loadConfig() : undefined);
  const dayOfWeek = effectiveSendAt(draft, nowMs).dayOfWeek;
  const groupId = draft.targetType === 'GROUP' && /^\d{1,20}$/.test(String(draft.groupId ?? '')) ? draft.groupId : null;

  const [recentRes, peakRes, audienceRes, groupRes] = await Promise.all([
    runQuery(buildRecentAnnouncementsSql(nowMs), dbConfig),
    runQuery(buildReminderPeakSql(dayOfWeek), dbConfig),
    runQuery(buildAudienceSql(nowMs), dbConfig),
    groupId ? runQuery(buildGroupAudienceSql(groupId), dbConfig) : Promise.resolve(null),
  ]);

  const recentAnnouncements = recentRes.rows.map(([title, content, targetType, createdAt]) => ({
    title, content, targetType, createdAt,
  }));
  const reminderPeakMinutes = peakRes.rows.map(([minOfDay]) => Number(minOfDay)).filter(Number.isFinite);

  const [allMembers, allDevices, active7dMembers, active30dMembers] = (audienceRes.rows[0] ?? []).map((v) => Number(v) || 0);
  const audienceStats = {
    ALL: {
      memberCount: allMembers ?? 0,
      tokenCount: allDevices ?? 0,
      active7dMembers: active7dMembers ?? 0,
      active30dMembers: active30dMembers ?? 0,
      inactive30dRatio: allMembers > 0 ? (allMembers - (active30dMembers ?? 0)) / allMembers : 0,
    },
  };
  const groupRow = groupRes?.rows?.[0];
  if (groupRow && Number(groupRow[0]) > 0) {
    audienceStats.GROUP = { memberCount: Number(groupRow[0]), tokenCount: Number(groupRow[1]) || 0 };
  }

  return {
    recentAnnouncements,
    scheduledAnnouncements: [], // 콘솔에 예약 발송이 생기면 조회한다
    reminderPeakMinutes,
    audienceStats,
  };
}
