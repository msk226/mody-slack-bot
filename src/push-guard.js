// 푸시 공지 초안의 결정론적 가드레일 검증 및 슬랙 리포트 포맷터.
// LLM 출력을 그대로 신뢰하지 않고, 야간·길이·리마인더 겹침·피로도·중복·대상·딥링크를 코드로 판정한다.
// 판정 기준은 실제로 보낼 곳인 mody-server 공지 API(AdminAnnouncementService)에 맞춘다.
// 콘솔이 거절할 초안을 PASS로 보여주면 검증의 의미가 없기 때문이다.

import crypto from 'node:crypto';

// 서버 공지 API가 받는 대상 종류. ALL(활성 회원 전체), GROUP(그룹 참여 회원), MEMBERS(회원 ID 최대 100명).
export const TARGET_TYPES = new Set(['ALL', 'GROUP', 'MEMBERS']);

// 서버 NotificationLinkResolver가 실제로 만드는 앱 경로만 허용한다.
export const ALLOWED_DEEPLINK_PATTERNS = [
  /^\/home$/,
  /^\/groups\/\d+\/home$/,
  /^\/records$/,
  /^\/records\/(?:meal|exercise)$/,
  /^\/records\/\d+$/,
  /^\/groups\/\d+\/records\/\d+$/,
  /^\/challenges\/step$/,
  /^\/groups\/\d+\/challenges\/step$/,
  /^\/challenges\?tab=weekly$/,
  /^\/groups\/\d+\/challenges\?tab=weekly$/,
];

export const DEFAULT_RULES = {
  quietStartHour: 21, // 21:00 ~ 07:59 KST. 서버도 같은 시간대에 allowQuietHours=true가 있어야 보낸다.
  quietEndHour: 8,
  maxTitleLength: 50, // 서버 API 한도 (DB 컬럼은 100/500이지만 API가 먼저 거절한다)
  maxContentLength: 200,
  recommendedTitleLength: 25, // 잠금화면에서 잘리지 않는 권장 길이
  recommendedContentLength: 60,
  maxMembers: 100,
  reminderCollisionWindowMin: 15,
  announcementCollisionWindowMin: 120,
  fatigue24hThreshold: 1,
  fatigue7dThreshold: 2,
  inactiveRatioWarnThreshold: 0.5,
  defaultReminderPeakMinutes: [12 * 60, 18 * 60], // DB 조회가 비었을 때만 쓴다
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

// Slack mrkdwn 제어 문자만 바꾼다. 초안 문구에 <!channel> 같은 값이 있어도 채널 전체 호출이 되지 않는다.
export function escapeMrkdwn(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function hashAnnouncementCopy(title, content) {
  const normalized = `${String(title || '').trim()}\n${String(content || '').trim()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * ISO 문자열이나 MySQL DATETIME 문자열을 KST 기준으로 읽는다.
 * 오프셋이 없으면 KST로 본다. 봇을 돌리는 컴퓨터의 시간대에 따라 결과가 달라지지 않게 하기 위해서다.
 */
export function parseKstDate(value) {
  if (!value || typeof value !== 'string') return null;
  let text = value.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  if (!HAS_OFFSET.test(text)) text += '+09:00';
  const epochMs = Date.parse(text);
  if (Number.isNaN(epochMs)) return null;
  return kstParts(epochMs);
}

export function kstParts(epochMs) {
  const kst = new Date(epochMs + KST_OFFSET_MS);
  return {
    epochMs,
    year: kst.getUTCFullYear(),
    month: kst.getUTCMonth() + 1,
    day: kst.getUTCDate(),
    hour: kst.getUTCHours(),
    minute: kst.getUTCMinutes(),
    minutesOfDay: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
    dayOfWeek: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][kst.getUTCDay()],
  };
}

export function formatMinutesToHHMM(minutesOfDay) {
  const wrapped = ((minutesOfDay % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 콘솔은 예약 발송이 없어 누르는 즉시 보낸다. 시각이 없으면 지금 보낸다고 보고 판정한다.
export function effectiveSendAt(draft, nowMs) {
  return parseKstDate(draft?.scheduledAtKst) ?? kstParts(nowMs);
}

export function validatePushDraft(draft, rules = DEFAULT_RULES) {
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
  if (!TARGET_TYPES.has(draft.targetType)) {
    errors.push(`허용되지 않은 targetType입니다: ${draft.targetType} (ALL, GROUP, MEMBERS 중 하나)`);
  }
  if (draft.targetType === 'GROUP' && !/^\d{1,20}$/.test(String(draft.groupId ?? ''))) {
    errors.push('GROUP 대상에는 숫자 groupId가 필요합니다.');
  }
  if (draft.targetType === 'MEMBERS') {
    const ids = Array.isArray(draft.memberIds) ? draft.memberIds : [];
    if (ids.length === 0 || ids.length > rules.maxMembers || !ids.every((id) => /^\d{1,20}$/.test(String(id)))) {
      errors.push(`MEMBERS 대상에는 숫자 회원 ID가 1~${rules.maxMembers}개 필요합니다.`);
    }
  }
  if (draft.scheduledAtKst !== null && draft.scheduledAtKst !== undefined && !parseKstDate(draft.scheduledAtKst)) {
    errors.push(`scheduledAtKst 형식이 올바르지 않습니다: ${draft.scheduledAtKst}`);
  }
  return errors;
}

export function evaluatePushDraft(draft, dbContext = {}, nowMs = Date.now(), customRules = {}) {
  const rules = { ...DEFAULT_RULES, ...customRules };
  const blocks = [];
  const warnings = [];
  const infos = [];

  const schemaErrors = validatePushDraft(draft, rules);
  if (schemaErrors.length > 0) {
    for (const err of schemaErrors) blocks.push({ code: 'INVALID_DRAFT', message: err });
    return { status: 'BLOCK', blocks, warnings, infos, suggestedTimeKst: null };
  }

  const title = draft.title.trim();
  const content = draft.content.trim();

  // 1. 길이: 서버 API 한도는 차단, 잠금화면 권장 길이는 주의
  if (title.length > rules.maxTitleLength) {
    blocks.push({ code: 'TITLE_TOO_LONG', message: `제목이 공지 API 한도(${rules.maxTitleLength}자)를 넘습니다 (${title.length}자).` });
  } else if (title.length > rules.recommendedTitleLength) {
    warnings.push({ code: 'TITLE_LOCKSCREEN', message: `제목이 잠금화면 권장 길이(${rules.recommendedTitleLength}자)보다 깁니다 (${title.length}자).` });
  }
  if (content.length > rules.maxContentLength) {
    blocks.push({ code: 'CONTENT_TOO_LONG', message: `본문이 공지 API 한도(${rules.maxContentLength}자)를 넘습니다 (${content.length}자).` });
  } else if (content.length > rules.recommendedContentLength) {
    warnings.push({ code: 'CONTENT_LOCKSCREEN', message: `본문이 잠금화면 권장 길이(${rules.recommendedContentLength}자)보다 깁니다 (${content.length}자).` });
  }

  // 2. 딥링크: 앱에 없는 경로·외부 URL은 차단. 허용 경로여도 지금 공지 API에는 딥링크 필드가 없다.
  if (draft.deepLink) {
    if (!ALLOWED_DEEPLINK_PATTERNS.some((re) => re.test(draft.deepLink))) {
      blocks.push({ code: 'INVALID_DEEPLINK', message: `앱에 없는 경로이거나 외부 URL입니다: ${draft.deepLink}` });
    } else {
      warnings.push({ code: 'DEEPLINK_NOT_SUPPORTED', message: '지금 공지 API는 딥링크를 받지 않아, 알림을 누르면 앱 기본 화면이 열립니다.' });
    }
  }

  // 3. 발송 시각: 예약이 없으면 지금 보낸다고 보고 야간·리마인더 겹침을 판정한다.
  let suggestedTimeKst = null;
  const scheduled = parseKstDate(draft.scheduledAtKst);
  const sendAt = effectiveSendAt(draft, nowMs);
  if (scheduled) {
    if (scheduled.epochMs < nowMs - 60 * 1000) {
      blocks.push({ code: 'PAST_TIME', message: `발송 시각이 지났습니다 (${draft.scheduledAtKst}).` });
    }
    infos.push(`콘솔에는 예약 발송이 없어, ${formatMinutesToHHMM(scheduled.minutesOfDay)} KST에 콘솔에서 직접 보내야 합니다.`);
  } else {
    infos.push('발송 시각이 없어 지금 바로 보낸다고 보고 판정했습니다.');
  }

  const quiet = sendAt.hour >= rules.quietStartHour || sendAt.hour < rules.quietEndHour;
  const quietRange = `${String(rules.quietStartHour).padStart(2, '0')}:00~${String(rules.quietEndHour).padStart(2, '0')}:00 KST`;
  if (quiet && draft.allowQuietHours === true) {
    warnings.push({ code: 'QUIET_HOURS_ALLOWED', message: `야간(${quietRange}) 발송입니다. 콘솔에서 '야간 발송 허용'을 켜야 보낼 수 있고, 꼭 필요한 공지인지 확인해 주세요.` });
  } else if (quiet) {
    blocks.push({ code: 'NIGHT_QUIET_HOURS', message: `야간(${quietRange})에는 보내지 않습니다. 꼭 보내야 하면 야간 발송 허용을 명시해 주세요.` });
  }

  if (!quiet) {
    const peakMins = Array.isArray(dbContext.reminderPeakMinutes) && dbContext.reminderPeakMinutes.length > 0
      ? dbContext.reminderPeakMinutes
      : rules.defaultReminderPeakMinutes;
    const collidingPeak = peakMins.find((m) => Math.abs(sendAt.minutesOfDay - m) <= rules.reminderCollisionWindowMin);
    if (collidingPeak !== undefined) {
      const later = sendAt.minutesOfDay + 30;
      suggestedTimeKst = formatMinutesToHHMM(Math.floor(later / 60) < rules.quietStartHour ? later : sendAt.minutesOfDay - 30);
      warnings.push({
        code: 'REMINDER_COLLISION',
        message: `리마인더가 몰리는 시각(${formatMinutesToHHMM(collidingPeak)})과 ${rules.reminderCollisionWindowMin}분 이내로 겹칩니다. ${suggestedTimeKst} KST를 권장합니다.`,
      });
    }

    const others = Array.isArray(dbContext.scheduledAnnouncements) ? dbContext.scheduledAnnouncements : [];
    for (const item of others) {
      const other = parseKstDate(item.scheduledAtKst);
      if (!other) continue;
      const diffMin = Math.abs(sendAt.epochMs - other.epochMs) / 60000;
      if (diffMin <= rules.announcementCollisionWindowMin) {
        warnings.push({ code: 'ANNOUNCEMENT_COLLISION', message: `예정된 공지("${item.title}")와 ${Math.round(diffMin)}분 간격입니다.` });
      }
    }
  }

  // 4. 피로도·중복: 최근 공지(실패한 발송 제외)와 비교한다.
  const recent = Array.isArray(dbContext.recentAnnouncements) ? dbContext.recentAnnouncements : [];
  const draftHash = hashAnnouncementCopy(title, content);
  const cutoff24h = nowMs - 24 * 60 * 60 * 1000;
  const cutoff7d = nowMs - 7 * 24 * 60 * 60 * 1000;
  let count24h = 0;
  let count7d = 0;
  let duplicateFound = false;
  for (const item of recent) {
    const sentAt = parseKstDate(item.createdAt);
    if (!sentAt) continue;
    if (sentAt.epochMs >= cutoff7d) count7d += 1;
    if (sentAt.epochMs >= cutoff24h) {
      count24h += 1;
      if (hashAnnouncementCopy(item.title, item.content) === draftHash) duplicateFound = true;
    }
  }
  if (duplicateFound) {
    blocks.push({ code: 'DUPLICATE_COPY_24H', message: '최근 24시간 안에 같은 제목·본문의 공지를 보냈습니다.' });
  }
  if (count24h >= rules.fatigue24hThreshold) {
    warnings.push({ code: 'FATIGUE_24H', message: `최근 24시간 안에 보낸 공지가 ${count24h}건 있습니다 (피로도 주의).` });
  }
  if (count7d >= rules.fatigue7dThreshold) {
    warnings.push({ code: 'FATIGUE_7D', message: `최근 7일 동안 공지를 ${count7d}건 보냈습니다.` });
  }

  // 5. 대상 모수: 서버와 같이 활성 회원의 수신 가능한(enabled) 기기만 센다.
  if (draft.targetType === 'MEMBERS') {
    infos.push(`예상 대상: 지정한 회원 ${draft.memberIds.length}명 (정확한 기기 수는 콘솔 미리보기에서 확인)`);
  } else {
    const audience = dbContext.audienceStats?.[draft.targetType];
    if (audience) {
      infos.push(`예상 대상: 회원 ${audience.memberCount}명 / 수신 가능한 기기 ${audience.tokenCount}대`);
      if (draft.targetType === 'ALL' && typeof audience.inactive30dRatio === 'number'
        && audience.inactive30dRatio >= rules.inactiveRatioWarnThreshold) {
        const active = typeof audience.active30dMembers === 'number' ? ` (최근 30일 활동 ${audience.active30dMembers}명)` : '';
        warnings.push({
          code: 'HIGH_INACTIVE_RATIO',
          message: `전체 대상 중 최근 30일 미활동 비율이 ${Math.round(audience.inactive30dRatio * 100)}%입니다${active}. 콘솔에는 활성 회원만 고르는 대상이 없으니, 복귀를 유도하는 문구인지 확인하거나 대상을 그룹으로 좁혀 주세요.`,
        });
      }
    } else if (draft.targetType === 'GROUP') {
      warnings.push({ code: 'GROUP_NOT_FOUND', message: `그룹 ${draft.groupId}의 참여 회원을 찾지 못했습니다. 그룹 ID를 확인해 주세요.` });
    }
  }

  // 6. LLM의 문구 점검 결과
  if (draft.copyChecks?.hasTypo) {
    warnings.push({ code: 'COPY_TYPO', message: '문구에 오탈자·어색한 표현 의심이 있습니다.' });
  }
  if (draft.copyChecks?.hasAdRisk) {
    warnings.push({ code: 'AD_COMPLIANCE', message: '영리성 광고 표기("(광고)"·수신거부) 필요 여부를 확인해 주세요.' });
  }
  if (Array.isArray(draft.needsClarification) && draft.needsClarification.length > 0) {
    warnings.push({ code: 'NEEDS_CLARIFICATION', message: `확인이 필요한 항목: ${draft.needsClarification.join(', ')}` });
  }

  const status = blocks.length > 0 ? 'BLOCK' : warnings.length > 0 ? 'WARN' : 'PASS';
  return { status, blocks, warnings, infos, suggestedTimeKst };
}

function targetLabel(draft) {
  if (draft.targetType === 'GROUP') return `GROUP (그룹 ${draft.groupId})`;
  if (draft.targetType === 'MEMBERS') return `MEMBERS (${Array.isArray(draft.memberIds) ? draft.memberIds.length : 0}명)`;
  return draft.targetType;
}

export function formatPushReviewReport(draft, evaluation) {
  const badge = evaluation.status === 'BLOCK'
    ? ':octagonal_sign: *보낼 수 없음 (BLOCK)*'
    : evaluation.status === 'WARN'
      ? ':warning: *확인 필요 (WARN)*'
      : ':white_check_mark: *검증 통과 (PASS)*';

  const lines = [
    `*푸시 공지 사전 검증 결과* — ${badge}`,
    '',
    '*1. 초안 미리보기*',
    `• 제목 : ${escapeMrkdwn(draft.title)}`,
    `• 본문 : ${escapeMrkdwn(draft.content)}`,
    `• 대상 : \`${escapeMrkdwn(targetLabel(draft))}\``,
    `• 희망 시각 : ${escapeMrkdwn(draft.scheduledAtKst || '미지정 (바로 발송)')}`,
    `• 야간 발송 허용 : ${draft.allowQuietHours === true ? '예' : '아니오'}`,
    `• 딥링크 : ${escapeMrkdwn(draft.deepLink || '없음')}`,
  ];

  if (evaluation.infos.length > 0) {
    lines.push('', '*2. 참고*');
    for (const info of evaluation.infos) lines.push(`• ${escapeMrkdwn(info)}`);
  }
  if (evaluation.blocks.length > 0) {
    lines.push('', '*차단 사유 (수정 필수)*');
    for (const b of evaluation.blocks) lines.push(`• [${b.code}] ${escapeMrkdwn(b.message)}`);
  }
  if (evaluation.warnings.length > 0) {
    lines.push('', '*주의·권고 항목*');
    for (const w of evaluation.warnings) lines.push(`• [${w.code}] ${escapeMrkdwn(w.message)}`);
  }

  lines.push('', '→ _봇은 검증·초안 정리만 합니다. 최종 승인과 발송은 운영 콘솔에서 해 주세요._');
  return lines.join('\n');
}
