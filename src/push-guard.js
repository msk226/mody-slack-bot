// 푸시 공지 초안의 결정론적 가드레일 검증 및 슬랙 리포트 포맷터.
// LLM 출력을 그대로 신뢰하지 않고, 야간 차단·시간대 충돌·피로도·중복·대상 모수·딥링크를 코드로 판정한다.

import crypto from 'node:crypto';

export const ALLOWED_TARGET_TYPES = new Set([
  'ALL',
  'ACTIVE_7D',
  'ACTIVE_30D',
  'SPECIFIC_MEMBERS',
]);

export const ALLOWED_DEEPLINK_PATTERNS = [
  /^\/home$/,
  /^\/groups(\/[0-9]+)?$/,
  /^\/records(\/[0-9]+)?$/,
  /^\/notifications$/,
  /^\/settings$/,
];

const DEFAULT_RULES = {
  nightStartHour: 21, // 21:00 ~ 07:59 KST BLOCK
  nightEndHour: 8,
  maxTitleLength: 100,
  maxContentLength: 500,
  recommendedTitleLength: 25,
  recommendedContentLength: 60,
  reminderCollisionWindowMin: 15,
  announcementCollisionWindowMin: 120,
  fatigue24hThreshold: 1,
  fatigue7dThreshold: 2,
  inactiveRatioWarnThreshold: 0.5,
  defaultReminderPeakMinutes: [12 * 60, 18 * 60, 21 * 60], // 12:00, 18:00, 21:00 KST
};

export function hashAnnouncementCopy(title, content) {
  const normalized = `${String(title || '').trim()}\n${String(content || '').trim()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function parseKstDate(isoString) {
  if (!isoString || typeof isoString !== 'string') return null;
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) return null;
  // Convert to KST (+09:00) wall-clock fields reliably regardless of host TZ
  const kstMs = parsed.getTime() + 9 * 60 * 60 * 1000;
  const kst = new Date(kstMs);
  return {
    epochMs: parsed.getTime(),
    year: kst.getUTCFullYear(),
    month: kst.getUTCMonth() + 1,
    day: kst.getUTCDate(),
    hour: kst.getUTCHours(),
    minute: kst.getUTCMinutes(),
    minutesOfDay: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
  };
}

export function formatMinutesToHHMM(minutesOfDay) {
  const wrapped = ((minutesOfDay % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function validatePushDraft(draft) {
  const errors = [];
  if (!draft || typeof draft !== 'object') {
    return ['초안 객체가 비어 있습니다.'];
  }
  if (typeof draft.title !== 'string' || !draft.title.trim()) {
    errors.push('title은 비어 있을 수 없습니다.');
  }
  if (typeof draft.content !== 'string' || !draft.content.trim()) {
    errors.push('content는 비어 있을 수 없습니다.');
  }
  if (!ALLOWED_TARGET_TYPES.has(draft.targetType)) {
    errors.push(`허용되지 않은 targetType입니다: ${draft.targetType}`);
  }
  if (draft.scheduledAtKst !== null && draft.scheduledAtKst !== undefined) {
    if (!parseKstDate(draft.scheduledAtKst)) {
      errors.push(`scheduledAtKst 형식이 올바르지 않습니다: ${draft.scheduledAtKst}`);
    }
  }
  return errors;
}

export function evaluatePushDraft(draft, dbContext = {}, nowMs = Date.now(), customRules = {}) {
  const rules = { ...DEFAULT_RULES, ...customRules };
  const blocks = [];
  const warnings = [];
  const infos = [];

  const schemaErrors = validatePushDraft(draft);
  if (schemaErrors.length > 0) {
    for (const err of schemaErrors) blocks.push({ code: 'INVALID_DRAFT', message: err });
    return { status: 'BLOCK', blocks, warnings, infos, suggestedTimeKst: null };
  }

  const title = draft.title.trim();
  const content = draft.content.trim();

  // 1. Length checks (DB schema hard limit vs lockscreen recommended)
  if (title.length > rules.maxTitleLength) {
    blocks.push({ code: 'TITLE_TOO_LONG', message: `제목이 DB 한도(${rules.maxTitleLength}자)를 초과했습니다 (${title.length}자).` });
  } else if (title.length > rules.recommendedTitleLength) {
    warnings.push({ code: 'TITLE_LOCKSCREEN', message: `제목이 잠금화면 권장 길이(${rules.recommendedTitleLength}자)보다 깁니다 (${title.length}자).` });
  }

  if (content.length > rules.maxContentLength) {
    blocks.push({ code: 'CONTENT_TOO_LONG', message: `본문이 DB 한도(${rules.maxContentLength}자)를 초과했습니다 (${content.length}자).` });
  } else if (content.length > rules.recommendedContentLength) {
    warnings.push({ code: 'CONTENT_LOCKSCREEN', message: `본문이 잠금화면 권장 길이(${rules.recommendedContentLength}자)보다 깁니다 (${content.length}자).` });
  }

  // 2. Deep link allowlist check
  if (draft.deepLink) {
    const ok = ALLOWED_DEEPLINK_PATTERNS.some((re) => re.test(draft.deepLink));
    if (!ok) {
      blocks.push({ code: 'INVALID_DEEPLINK', message: `허용되지 않은 딥링크 경로입니다: ${draft.deepLink}` });
    }
  }

  // 3. Night-time restriction & time collision checks
  let suggestedTimeKst = null;
  const kst = parseKstDate(draft.scheduledAtKst);
  if (!kst) {
    warnings.push({ code: 'TIME_UNSPECIFIED', message: '발송 시각이 지정되지 않았습니다. 확정 전 발송 시각을 지정해 주세요.' });
  } else {
    if (kst.epochMs < nowMs - 60 * 1000) {
      blocks.push({ code: 'PAST_TIME', message: `발송 시각이 과거입니다 (${draft.scheduledAtKst}).` });
    }
    if (kst.hour >= rules.nightStartHour || kst.hour < rules.nightEndHour) {
      blocks.push({
        code: 'NIGHT_QUIET_HOURS',
        message: `야간 금지 시간대(${String(rules.nightStartHour).padStart(2, '0')}:00~${String(rules.nightEndHour).padStart(2, '0')}:00 KST)에는 발송할 수 없습니다.`,
      });
    } else {
      // Reminder peak collision
      const peakMins = Array.isArray(dbContext.reminderPeakMinutes) && dbContext.reminderPeakMinutes.length > 0
        ? dbContext.reminderPeakMinutes
        : rules.defaultReminderPeakMinutes;

      const collidingPeak = peakMins.find(
        (m) => Math.abs(kst.minutesOfDay - m) <= rules.reminderCollisionWindowMin
      );
      if (collidingPeak !== undefined) {
        const altMin = kst.minutesOfDay + 30;
        if (Math.floor(altMin / 60) < rules.nightStartHour) {
          suggestedTimeKst = formatMinutesToHHMM(altMin);
        } else {
          suggestedTimeKst = formatMinutesToHHMM(kst.minutesOfDay - 30);
        }
        warnings.push({
          code: 'REMINDER_COLLISION',
          message: `리마인더 집중 시각(${formatMinutesToHHMM(collidingPeak)})과 ${rules.reminderCollisionWindowMin}분 이내로 겹칩니다. ${suggestedTimeKst} KST로 조정을 권장합니다.`,
        });
      }

      // Scheduled announcement collision (±120 min)
      const scheduled = Array.isArray(dbContext.scheduledAnnouncements) ? dbContext.scheduledAnnouncements : [];
      for (const item of scheduled) {
        const other = parseKstDate(item.scheduledAtKst);
        if (!other) continue;
        const diffMin = Math.abs(kst.epochMs - other.epochMs) / 60000;
        if (diffMin <= rules.announcementCollisionWindowMin) {
          warnings.push({
            code: 'ANNOUNCEMENT_COLLISION',
            message: `기존 예약 공지("${item.title}")와 ${Math.round(diffMin)}분 간격으로 겹칩니다.`,
          });
        }
      }
    }
  }

  // 4. Fatigue & duplicate checks against recent announcements
  const recent = Array.isArray(dbContext.recentAnnouncements) ? dbContext.recentAnnouncements : [];
  const draftHash = hashAnnouncementCopy(title, content);
  const cutoff24h = nowMs - 24 * 60 * 60 * 1000;
  const cutoff7d = nowMs - 7 * 24 * 60 * 60 * 1000;

  let count24h = 0;
  let count7d = 0;
  let duplicateFound = false;

  for (const item of recent) {
    const t = new Date(item.createdAt).getTime();
    if (Number.isNaN(t)) continue;
    if (t >= cutoff7d) count7d += 1;
    if (t >= cutoff24h) {
      count24h += 1;
      if (hashAnnouncementCopy(item.title, item.content) === draftHash) {
        duplicateFound = true;
      }
    }
  }

  if (duplicateFound) {
    blocks.push({ code: 'DUPLICATE_COPY_24H', message: '최근 24시간 내에 동일한 제목·본문으로 발송된 공지가 있습니다.' });
  }
  if (count24h >= rules.fatigue24hThreshold) {
    warnings.push({ code: 'FATIGUE_24H', message: `최근 24시간 내 공지 발송 이력이 ${count24h}건 있습니다 (피로도 주의).` });
  }
  if (count7d >= rules.fatigue7dThreshold) {
    warnings.push({ code: 'FATIGUE_7D', message: `최근 7일간 공지가 ${count7d}건 발송되었습니다.` });
  }

  // 5. Audience size & inactive ratio check
  const audience = dbContext.audienceStats?.[draft.targetType];
  if (audience) {
    infos.push(`예상 대상: 회원 ${audience.memberCount}명 / 유효 토큰 ${audience.tokenCount}개`);
    if (
      draft.targetType === 'ALL' &&
      typeof audience.inactive30dRatio === 'number' &&
      audience.inactive30dRatio >= rules.inactiveRatioWarnThreshold
    ) {
      warnings.push({
        code: 'HIGH_INACTIVE_RATIO',
        message: `전체 대상 중 최근 30일 미활동 비율이 ${Math.round(audience.inactive30dRatio * 100)}%입니다. ACTIVE_7D 또는 ACTIVE_30D 타겟을 권장합니다.`,
      });
    }
  }

  // 6. Copy quality checks surfaced from LLM
  if (draft.copyChecks?.hasTypo) {
    warnings.push({ code: 'COPY_TYPO', message: '문구에 오탈자·어색한 표현 의심이 있습니다.' });
  }
  if (draft.copyChecks?.hasAdRisk) {
    warnings.push({ code: 'AD_COMPLIANCE', message: '영리성 광고 표기("(광고)"·수신거부) 필요 여부를 확인해 주세요.' });
  }
  if (Array.isArray(draft.needsClarification) && draft.needsClarification.length > 0) {
    warnings.push({
      code: 'NEEDS_CLARIFICATION',
      message: `확인이 필요한 항목: ${draft.needsClarification.join(', ')}`,
    });
  }

  const status = blocks.length > 0 ? 'BLOCK' : warnings.length > 0 ? 'WARN' : 'PASS';
  return { status, blocks, warnings, infos, suggestedTimeKst };
}

export function formatPushReviewReport(draft, evaluation) {
  const badge =
    evaluation.status === 'BLOCK'
      ? ':octagonal_sign: *발송 불가 (BLOCK)*'
      : evaluation.status === 'WARN'
        ? ':warning: *주의 필요 (WARN)*'
        : ':white_check_mark: *검증 통과 (PASS)*';

  const lines = [
    `*푸시 공지 사전 검증 결과* — ${badge}`,
    '',
    '*1. 초안 미리보기*',
    `• 제목 : ${draft.title}`,
    `• 본문 : ${draft.content}`,
    `• 대상 : \`${draft.targetType}\``,
    `• 희망 시각 : ${draft.scheduledAtKst || '미지정'}`,
    `• 딥링크 : ${draft.deepLink || '없음'}`,
  ];

  if (evaluation.infos.length > 0) {
    lines.push('', '*2. 예상 모수*');
    for (const info of evaluation.infos) lines.push(`• ${info}`);
  }

  if (evaluation.blocks.length > 0) {
    lines.push('', '*차단 사유 (수정 필수)*');
    for (const b of evaluation.blocks) lines.push(`• [${b.code}] ${b.message}`);
  }

  if (evaluation.warnings.length > 0) {
    lines.push('', '*주의·권고 항목*');
    for (const w of evaluation.warnings) lines.push(`• [${w.code}] ${w.message}`);
  }

  lines.push('', '→ _봇은 검증·초안 정리만 수행합니다. 최종 승인 및 발송은 운영 콘솔에서 진행해 주세요._');
  return lines.join('\n');
}
