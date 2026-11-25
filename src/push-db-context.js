// 푸시 사전 검증에 필요한 운영 DB 읽기 전용 컨텍스트 로더.
// 반드시 src/prod-db/guard.js + runner.js (START TRANSACTION READ ONLY + ROLLBACK)만 사용한다.

import { prepareReadOnlyQuery } from './prod-db/guard.js';
import { loadConfig, runSql } from './prod-db/runner.js';

async function queryReadOnly(rawSql, config) {
  const sql = prepareReadOnlyQuery(rawSql);
  return runSql(sql, config);
}

export async function loadPushDbContext(config = loadConfig()) {
  const [recentRes, peakRes, audienceRes] = await Promise.all([
    queryReadOnly(
      `SELECT title, content, target_type, created_at
       FROM admin_announcement
       WHERE created_at >= NOW() - INTERVAL 7 DAY
       ORDER BY created_at DESC
       LIMIT 20`,
      config
    ),
    queryReadOnly(
      `SELECT HOUR(t) * 60 + MINUTE(t) AS min_of_day, COUNT(*) AS cnt
       FROM (
         SELECT breakfast_time AS t FROM notification_setting WHERE deleted_at IS NULL AND status = 'ACTIVE' AND meal_reminder_enabled = 1 AND breakfast_time IS NOT NULL
         UNION ALL
         SELECT lunch_time AS t FROM notification_setting WHERE deleted_at IS NULL AND status = 'ACTIVE' AND meal_reminder_enabled = 1 AND lunch_time IS NOT NULL
         UNION ALL
         SELECT dinner_time AS t FROM notification_setting WHERE deleted_at IS NULL AND status = 'ACTIVE' AND meal_reminder_enabled = 1 AND dinner_time IS NOT NULL
         UNION ALL
         SELECT exercise_time AS t FROM notification_setting WHERE deleted_at IS NULL AND status = 'ACTIVE' AND exercise_reminder_enabled = 1 AND exercise_time IS NOT NULL
       ) x
       GROUP BY min_of_day
       HAVING cnt >= 15
       ORDER BY cnt DESC
       LIMIT 10`,
      config
    ),
    queryReadOnly(
      `WITH active_7d AS (
         SELECT DISTINCT member_id FROM activity_record
         WHERE deleted_at IS NULL AND status = 'ACTIVE' AND uploaded_at >= NOW() - INTERVAL 7 DAY
       ),
       active_30d AS (
         SELECT DISTINCT member_id FROM activity_record
         WHERE deleted_at IS NULL AND status = 'ACTIVE' AND uploaded_at >= NOW() - INTERVAL 30 DAY
       ),
       valid_tokens AS (
         SELECT member_id, COUNT(*) AS token_cnt
         FROM member_push_token
         WHERE deleted_at IS NULL AND status = 'ACTIVE'
         GROUP BY member_id
       )
       SELECT
         COUNT(DISTINCT m.id) AS all_members,
         COALESCE(SUM(vt.token_cnt), 0) AS all_tokens,
         COUNT(DISTINCT a7.member_id) AS active_7d_members,
         COALESCE(SUM(CASE WHEN a7.member_id IS NOT NULL THEN vt.token_cnt ELSE 0 END), 0) AS active_7d_tokens,
         COUNT(DISTINCT a30.member_id) AS active_30d_members,
         COALESCE(SUM(CASE WHEN a30.member_id IS NOT NULL THEN vt.token_cnt ELSE 0 END), 0) AS active_30d_tokens
       FROM member m
       LEFT JOIN valid_tokens vt ON vt.member_id = m.id
       LEFT JOIN active_7d a7 ON a7.member_id = m.id
       LEFT JOIN active_30d a30 ON a30.member_id = m.id
       WHERE m.deleted_at IS NULL AND m.status = 'ACTIVE'`,
      config
    ),
  ]);

  const recentAnnouncements = recentRes.rows.map(([title, content, targetType, createdAt]) => ({
    title,
    content,
    targetType,
    createdAt,
  }));

  const reminderPeakMinutes = peakRes.rows.map(([minOfDay]) => Number(minOfDay)).filter(Number.isFinite);

  const row = audienceRes.rows[0] || [0, 0, 0, 0, 0, 0];
  const allMembers = Number(row[0]) || 0;
  const allTokens = Number(row[1]) || 0;
  const active7dMembers = Number(row[2]) || 0;
  const active7dTokens = Number(row[3]) || 0;
  const active30dMembers = Number(row[4]) || 0;
  const active30dTokens = Number(row[5]) || 0;

  return {
    recentAnnouncements,
    scheduledAnnouncements: [], // Phase 2: admin_announcement.scheduled_at 도입 후 조회
    reminderPeakMinutes,
    audienceStats: {
      ALL: {
        memberCount: allMembers,
        tokenCount: allTokens,
        inactive30dRatio: allMembers > 0 ? (allMembers - active30dMembers) / allMembers : 0,
      },
      ACTIVE_7D: { memberCount: active7dMembers, tokenCount: active7dTokens, inactive30dRatio: 0 },
      ACTIVE_30D: { memberCount: active30dMembers, tokenCount: active30dTokens, inactive30dRatio: 0 },
    },
  };
}
