// 신고 알림의 숨김·기각 버튼 (mody-server LLD-0040).
// 버튼을 누른 Slack 사용자 ID를 전용 비밀값으로 서명해 서버의 Slack 처리 API를 부른다.
// 처리 권한(관리자 계정 연결, OPERATOR 이상)과 처리자 기록은 서버가 정한다. 봇은 사람 대신 판단하지 않는다.
// 에이전트를 부르지 않는 고정 코드다. 비밀값은 이름에 SECRET이 들어가 에이전트 환경변수로 넘어가지 않는다.
import { createHmac, randomUUID } from 'node:crypto';

export const REPORT_ACTION_IDS = ['report_hide', 'report_dismiss'];

const KIND_PATH = { RECORD: 'records', COMMENT: 'comments' };
const KIND_LABEL = { RECORD: '기록', COMMENT: '댓글' };
const RESOLUTION_LABEL = { HIDDEN: '숨김', DISMISSED: '기각' };
const REQUEST_TIMEOUT_MS = 10_000;

export function loadReportActionConfig(env = process.env) {
  return {
    enabled: env.REPORT_ACTIONS_ENABLED === 'true',
    baseUrl: (env.REPORT_ACTION_BASE_URL ?? '').replace(/\/+$/, ''),
    secret: env.REPORT_ACTION_SECRET ?? '',
    environment: env.REPORT_ACTION_ENVIRONMENT ?? 'dev',
    channelIds: new Set(String(env.REPORT_ACTION_CHANNEL_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean)),
  };
}

/**
 * 운영 처리는 아직 막는다. 봇의 운영 변경 제한(ENABLE_PROD_WRITES, 서버 담당자 한정)과의 관계를 정하기 전이다.
 * @returns {{ allowed: true } | { allowed: false, reason: string }}
 */
export function decideReportAction({ config, channelId }) {
  if (!config.enabled) return { allowed: false, reason: 'disabled' };
  if (config.environment === 'prod') return { allowed: false, reason: 'prod_not_allowed' };
  if (!config.baseUrl || !config.secret) return { allowed: false, reason: 'not_configured' };
  if (config.channelIds.size > 0 && !config.channelIds.has(channelId)) {
    return { allowed: false, reason: 'channel_not_allowed' };
  }
  return { allowed: true };
}

export function parseActionValue(value = '') {
  const match = /^(RECORD|COMMENT):(\d{1,20})$/.exec(value);
  return match ? { kind: match[1], targetId: match[2] } : null;
}

export function actionPath({ kind, targetId }, actionId) {
  const verb = actionId === 'report_hide' ? 'hide' : 'dismiss';
  return `/api/v1/admin/slack/reports/${KIND_PATH[kind]}/${targetId}/${verb}`;
}

// 서버 SlackActionAuthenticator.sign과 같은 문자열을 만든다.
export function signRequest({ secret, timestamp, method, path, slackUserId }) {
  const base = ['v1', timestamp, method, path, slackUserId].join(':');
  return `v1=${createHmac('sha256', secret).update(base).digest('hex')}`;
}

export function formatResolvedAt(value) {
  if (!value) return '';
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]} ${match[2]}` : String(value);
}

function resolverLabel(result) {
  if (result.resolverSlackUserId) return `<@${result.resolverSlackUserId}>`;
  return result.resolvedBy ? `${result.resolvedBy} (콘솔)` : '알 수 없음';
}

export function renderResultLine(result, clickedBy) {
  const resolution = RESOLUTION_LABEL[result.resolution] ?? result.resolution;
  const at = formatResolvedAt(result.resolvedAt);
  if (result.outcome === 'RESOLVED') {
    return `:white_check_mark: *처리됨: ${resolution}* · ${resolverLabel(result)} · ${at}`;
  }
  return `:information_source: *이미 처리된 신고입니다: ${resolution}* · ${resolverLabel(result)} · ${at}`
    + ` (확인: <@${clickedBy}>)`;
}

// 원래 메시지에서 버튼 줄을 빼고 처리 결과를 붙인다. 버튼이 사라지므로 같은 메시지로 두 번 처리하지 않는다.
export function renderResolvedBlocks(blocks = [], result, clickedBy) {
  const kept = blocks.filter((block) => block.type !== 'actions');
  return [...kept, { type: 'context', elements: [{ type: 'mrkdwn', text: renderResultLine(result, clickedBy) }] }];
}

export function denyText(reason) {
  switch (reason) {
    case 'disabled':
    case 'not_configured':
      return ':no_entry: Slack에서 신고를 처리하는 기능이 꺼져 있습니다. 콘솔에서 처리해 주세요.';
    case 'prod_not_allowed':
      return ':no_entry: 운영 신고는 아직 Slack에서 처리할 수 없습니다. 콘솔에서 처리해 주세요.';
    case 'channel_not_allowed':
      return ':no_entry: 이 채널의 신고 버튼은 처리하지 않습니다.';
    case 401:
      return ':no_entry: 서버가 봇의 요청을 확인하지 못했습니다(서명). 서버 담당자에게 알려 주세요.';
    case 403:
      return ':no_entry: 처리 권한이 없습니다. 관리자 계정에 Slack이 연결돼 있고 조회 전용(VIEWER)이 아니어야 합니다.';
    case 404:
      return ':warning: 신고를 찾지 못했습니다. 콘솔에서 확인해 주세요.';
    default:
      return ':warning: 처리하지 못했습니다. 잠시 뒤 다시 누르거나 콘솔에서 처리해 주세요.';
  }
}

/**
 * Bolt `app.action` 핸들러 본체. ack는 호출하는 쪽에서 먼저 한다.
 * 결과는 response_url(respond)로 원래 메시지를 바꾸고, 거절·실패는 누른 사람에게만 보인다.
 */
export async function handleReportAction({
  body, action, respond, config, auditLog, fetchImpl = fetch, now = () => Date.now(),
}) {
  const startedAt = now();
  const channelId = body.channel?.id;
  const slackUserId = body.user?.id;
  const requestId = `report-${randomUUID().slice(0, 8)}`;
  const audit = (status, errorCode) => Promise.resolve(auditLog?.record({
    requestId, type: 'report_action', status, environment: config.environment, slackChannel: channelId,
    slackUser: slackUserId, durationMs: now() - startedAt, errorCode,
  })).catch((error) => console.error('report action audit failed:', error.message));
  const tellClicker = (text) => respond({ response_type: 'ephemeral', replace_original: false, text });

  const decision = decideReportAction({ config, channelId });
  const target = parseActionValue(action?.value);
  if (!decision.allowed || !target || !slackUserId || !REPORT_ACTION_IDS.includes(action?.action_id)) {
    const reason = decision.allowed ? 'invalid_action' : decision.reason;
    await tellClicker(denyText(reason));
    await audit('denied', reason);
    return { status: 'denied', reason };
  }

  const path = actionPath(target, action.action_id);
  const timestamp = String(Math.floor(now() / 1000));
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'X-Slack-User-Id': slackUserId,
        'X-Slack-Action-Timestamp': timestamp,
        'X-Slack-Action-Signature': signRequest({
          secret: config.secret, timestamp, method: 'POST', path, slackUserId,
        }),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`report action ${requestId} request failed:`, error.message);
    await tellClicker(denyText('network'));
    await audit('failed', 'network');
    return { status: 'failed', reason: 'network' };
  }

  if (!response.ok) {
    await tellClicker(denyText(response.status));
    await audit('failed', String(response.status));
    return { status: 'failed', reason: response.status };
  }

  const result = (await response.json()).result;
  await respond({
    replace_original: true,
    text: `${KIND_LABEL[target.kind]} 신고 ${RESOLUTION_LABEL[result.resolution] ?? ''} 처리 결과`,
    blocks: renderResolvedBlocks(body.message?.blocks, result, slackUserId),
  });
  await audit(result.outcome === 'RESOLVED' ? 'success' : 'already_resolved');
  return { status: result.outcome };
}
