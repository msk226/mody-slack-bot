import 'dotenv/config';
import { App } from '@slack/bolt';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { AuditLog } from './audit-log.js';
import { inferEnvironment, parseAgentResult, renderAgentResult } from './agent-contract.js';
import { JobQueue } from './job-queue.js';
import { alertEnvironment, markAlertEnvironment, setStatusReaction, slackMessage, stripStatusEmoji } from './slack-status.js';
import { ensureErrorIssue } from './github-issue.js';
import { startDailyReportTrigger } from './daily-report-trigger.js';
import { createDailyInsightRunner, startDailyInsight } from './daily-insight.js';
import {
  buildSafeChildEnvironment,
  findPreviousUserRequest,
  isHealthQuestion,
  isHostFileRequest,
  isThreadSummaryRequest,
  isVersionQuestion,
  stripSlackMentions,
} from './request-policy.js';

const execFileAsync = promisify(execFile);

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100);
});

const config = {
  slackAppToken: requiredEnv('SLACK_APP_TOKEN'),
  slackBotToken: requiredEnv('SLACK_BOT_TOKEN'),
  errorChannelId: requiredEnv('SLACK_ERROR_CHANNEL_ID'),
  repoPath: process.env.MODY_REPO_PATH ?? '/Users/minseokkim/Desktop/Code/mody-server',
  githubRepo: process.env.GITHUB_REPO ?? 'Central-MakeUs/mody-server',
  autoAnalyzeErrors: process.env.AUTO_ANALYZE_ERRORS !== 'false',
  autoCreateIssues: process.env.AUTO_CREATE_ISSUES !== 'false',
  ghPath: process.env.GH_PATH ?? '/opt/homebrew/bin/gh',
  issueLabels: (process.env.GITHUB_ISSUE_LABELS ?? 'bug').split(',').map((label) => label.trim()).filter(Boolean),
  issueCacheFile: process.env.ERROR_ISSUE_CACHE_FILE ?? path.join(process.cwd(), 'logs', 'error-issues.json'),
  dailyReportTriggerEnabled: process.env.DAILY_REPORT_TRIGGER_ENABLED !== 'false',
  dailyReportTime: process.env.DAILY_REPORT_TIME ?? '09:00',
  dailyReportStateFile: process.env.DAILY_REPORT_STATE_FILE ?? path.join(process.cwd(), 'logs', 'daily-report-trigger.json'),
  dailyInsightEnabled: process.env.DAILY_INSIGHT_ENABLED !== 'false',
  dailyReportChannelId: process.env.DAILY_REPORT_CHANNEL_ID ?? 'C0C82K2MKRT',
  dailyInsightStateFile: process.env.DAILY_INSIGHT_STATE_FILE ?? path.join(process.cwd(), 'logs', 'daily-insight.json'),
  useCodexAnalysis: process.env.USE_CODEX_ANALYSIS !== 'false',
  codexAnalysisModel: process.env.CODEX_ANALYSIS_MODEL ?? 'gpt-6-luna',
  codexReasoningEffort: process.env.CODEX_REASONING_EFFORT ?? 'medium',
  codexAnalysisTimeoutMs: Number(process.env.CODEX_ANALYSIS_TIMEOUT_MS ?? 0),
  processExistingMessages: process.env.PROCESS_EXISTING_MESSAGES === 'true',
  enablePrivilegedOperations: process.env.ENABLE_PRIVILEGED_OPERATIONS !== 'false',
  pollIntervalMs: Number(process.env.SLACK_POLL_INTERVAL_MS ?? 60_000),
  slackWatchdogMs: Number(process.env.SLACK_WATCHDOG_MS ?? 120000),
  agentConcurrency: Number(process.env.AGENT_CONCURRENCY ?? 1),
  agentTimeoutMs: Number(process.env.AGENT_TIMEOUT_MS ?? 20 * 60 * 1000),
  agentPromptPath: process.env.AGENT_PROMPT_PATH
    ?? path.join(process.cwd(), 'prompts', 'mody-agent.md'),
  agentResultSchemaPath: process.env.AGENT_RESULT_SCHEMA_PATH
    ?? path.join(process.cwd(), 'config', 'agent-result.schema.json'),
  handledAlertDirectory: process.env.HANDLED_ALERT_DIRECTORY
    ?? path.join(process.cwd(), 'logs', 'handled-alerts'),
  auditDirectory: process.env.AUDIT_DIRECTORY
    ?? path.join(process.cwd(), 'logs', 'audit'),
};

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

const recentlyHandled = new Map();
const recentlyHandledMentions = new Set();
const consumedRequestMessages = new Set();
const pendingMentions = new Map();
const requestQueue = new JobQueue({ concurrency: config.agentConcurrency });
const auditLog = new AuditLog(config.auditDirectory);
const startedAtSlackTs = Date.now() / 1000;
let botUserId = process.env.SLACK_BOT_USER_ID;
let botId = process.env.SLACK_BOT_ID;
let pollInProgress = false;
let lastSuccessfulPollAt = Date.now();

app.event('message', async ({ event, client }) => {
  if (isOwnBotMessage(event) || isUnsupportedMessage(event)) {
    return;
  }

  if (isBotMention(event.text)) {
    await processMention(event, client, stripBotMention(event.text ?? ''));
    return;
  }

  if (collectPendingMentionMessage(event)) {
    return;
  }

  if (!config.autoAnalyzeErrors || event.channel !== config.errorChannelId) {
    return;
  }

  const text = event.text ?? '';
  const parsed = parseServerError(text);
  if (!parsed) {
    return;
  }
  await markAlertEnvironment(client, event);
  if (isIgnoredNoise(parsed)) {
    return;
  }

  const key = fingerprint(parsed);
  if (isDuplicate(key) || !await claimAlert(event)) {
    return;
  }

  const progressMessage = await upsertThreadReply(client, event, ':loading: 오류 알림을 확인했습니다. 원인을 조사하고 있습니다.');
  await markProcessing(client, event);
  const progress = createProgressUpdater(client, progressMessage);

  const threadContext = await buildThreadContext(client, event, progress);

  const analysis = await analyzeError(parsed, progress, threadContext);
  const resultText = `:완료: *오류 조사 결과*\n${formatForSlack(renderErrorAnalysis(parsed, analysis))}`;
  await updateMessage(client, progressMessage, resultText);
  await linkErrorIssue(client, event, parsed, key, analysis, progressMessage, resultText);
  await markAnswered(client, event);
});

app.event('app_mention', async ({ event, client }) => {
  if (event.bot_id || event.subtype) {
    return;
  }

  await processMention(event, client, stripBotMention(event.text ?? ''));
});

if (!botUserId || !botId) {
  const botIdentity = await getBotIdentity();
  botUserId = botUserId ?? botIdentity.userId;
  botId = botId ?? botIdentity.botId;
}
await app.start();
console.log('Slack Error Harness is running in Socket Mode.');
startPolling();
startSlackWatchdog();
if (config.dailyReportTriggerEnabled) {
  startDailyReportTrigger({
    repo: config.githubRepo,
    ghPath: config.ghPath,
    workflow: 'daily-report.yml',
    time: config.dailyReportTime,
    stateFile: config.dailyReportStateFile,
  });
}
if (config.dailyInsightEnabled) {
  startDailyInsight({
    time: config.dailyReportTime,
    stateFile: config.dailyInsightStateFile,
    runFor: createDailyInsightRunner({
      client: app.client,
      botId,
      reportChannelId: config.dailyReportChannelId,
      errorChannelId: config.errorChannelId,
      githubRepo: config.githubRepo,
      ghPath: config.ghPath,
      parseServerError,
      isIgnoredNoise,
      alertEnvironment,
      analyze: (prompt) => runCodexReadOnly(prompt, null),
      post: (channel, threadTs, text) => upsertThreadReply(app.client, { channel, ts: threadTs }, text),
      format: formatForSlack,
    }),
  });
}

async function processMention(event, client, text, options = {}) {
  const mentionKey = `${event.channel}:${event.ts}`;
  if (!options.collected && recentlyHandledMentions.has(mentionKey)) {
    return;
  }
  if (!options.collected) {
    recentlyHandledMentions.add(mentionKey);
  }

  let requestText = text.trim();
  if (!requestText) {
    const messages = await getThreadReplies(client, event.channel, event.thread_ts ?? event.ts);
    const previousMessage = findPreviousUserRequest(messages, {
      eventTs: event.ts,
      userId: event.user,
      excludedMessageTs: [...consumedRequestMessages],
    });
    if (previousMessage) {
      consumedRequestMessages.add(previousMessage.ts);
      requestText = stripSlackMentions(previousMessage.text ?? '');
    }
  }

  if (!requestText) {
    waitForMentionRequest(event, client);
    return;
  }

  text = requestText;

  if (isSecretReadRequest(text)) {
    await upsertThreadReply(
      client,
      event,
      [
        '읽었습니다. 다만 `.env`, 토큰, 서버 환경변수 같은 민감 정보 원문은 읽거나 Slack에 노출하지 않습니다.',
        '필요하면 환경변수 키 존재 여부나 설정 위치만 확인하는 방식으로 답변하겠습니다.',
      ].join('\n'),
    );
    await markAnswered(client, event);
    return;
  }

  if (isHostFileRequest(text)) {
    await upsertThreadReply(
      client,
      event,
      'MODY 저장소 밖의 개인 로컬 파일·폴더는 찾거나 읽지 않습니다. MODY 코드, dev/prod 데이터, 서비스 상태와 관련된 요청을 남겨주세요.',
    );
    await markAnswered(client, event);
    return;
  }

  if (isThreadSummaryRequest(text)) {
    const progressMessage = await upsertThreadReply(client, event, ':loading: 스레드 대화를 읽고 요약하고 있습니다.');
    await markProcessing(client, event);
    const progress = createProgressUpdater(client, progressMessage);
    const threadContext = await buildThreadContext(client, event, progress);
    const summary = await summarizeThread(text, threadContext, progress);
    await updateMessage(client, progressMessage, `:완료: ${formatForSlack(summary)}`);
    await markAnswered(client, event);
    return;
  }

  if (isHealthQuestion(text)) {
    const progressMessage = await upsertThreadReply(client, event, renderHealthReply());
    await markAnswered(client, event);
    return;
  }

  if (isVersionQuestion(text)) {
    await upsertThreadReply(client, event, renderVersionReply());
    await markAnswered(client, event);
    return;
  }

  await handleAgentRequest(client, event, text);
}

function waitForMentionRequest(event, client) {
  const key = pendingMentionKey(event);
  const existing = pendingMentions.get(key);
  if (existing) {
    clearTimeout(existing.timeout);
    clearTimeout(existing.debounce);
  }

  const pending = {
    event,
    client,
    parts: [],
    debounce: null,
    timeout: setTimeout(async () => {
      pendingMentions.delete(key);
      await upsertThreadReply(client, event, '요청 내용을 같은 thread에 남겨주세요. 멘션 전후의 메시지를 함께 읽습니다.');
    }, 10_000),
  };
  pendingMentions.set(key, pending);
}

function collectPendingMentionMessage(event) {
  if (!event.user || !event.text?.trim()) {
    return false;
  }

  const key = pendingMentionKey(event);
  const pending = pendingMentions.get(key);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timeout);
  if (pending.debounce) {
    clearTimeout(pending.debounce);
  }
  pending.parts.push(event.text.trim());
  consumedRequestMessages.add(event.ts);
  pending.debounce = setTimeout(async () => {
    pendingMentions.delete(key);
    await processMention(
      pending.event,
      pending.client,
      pending.parts.join('\n'),
      { collected: true },
    );
  }, 2_000);
  return true;
}

function pendingMentionKey(event) {
  return `${event.channel}:${event.thread_ts ?? event.ts}:${event.user ?? ''}`;
}

async function handleAgentRequest(client, event, text) {
  const requestId = createRequestId(event);
  const progressMessage = await upsertThreadReply(client, event, `:확인중: 요청을 접수했습니다.\n_확인 ID: ${requestId}_`);
  await setStatusReaction(client, event, 'received');
  const progress = createProgressUpdater(client, progressMessage);
  const requestedEnvironment = inferEnvironment(text);

  const { position, promise } = requestQueue.enqueue(requestId, async () => {
    const startedAt = Date.now();
    let progressHeartbeat;
    await auditLog.record({
      requestId,
      type: 'agent_request',
      status: 'started',
      environment: requestedEnvironment,
      slackChannel: event.channel,
      slackUser: event.user,
    });

    try {
      await markProcessing(client, event);
      await progress(':loading: 작업을 시작했습니다. 요청과 이전 대화를 확인하고 있습니다.', { force: true });
      progressHeartbeat = startAgentProgressHeartbeat(progress, requestId, startedAt);
      const threadContext = await buildThreadContext(client, event, progress);
      const agentInstructions = await readFile(config.agentPromptPath, 'utf8');
      const prompt = buildAgentPrompt({
        agentInstructions,
        requestId,
        requestedEnvironment,
        text,
        threadContext,
      });
      const rawResult = await runCodexOperation(prompt, {
        outputSchemaPath: config.agentResultSchemaPath,
        privileged: true,
      });
      if (!rawResult) {
        throw new Error('empty_agent_result');
      }
      const result = parseAgentResult(rawResult);
      await auditLog.record({
        requestId,
        type: 'agent_request',
        status: result.status,
        environment: result.environment,
        slackChannel: event.channel,
        slackUser: event.user,
        durationMs: Date.now() - startedAt,
      });
      return { text: renderAgentResult(result, requestId), status: result.status };
    } catch (error) {
      console.error(`Agent request failed. requestId=${requestId}:`, error.message);
      await auditLog.record({
        requestId,
        type: 'agent_request',
        status: 'failed',
        environment: requestedEnvironment,
        slackChannel: event.channel,
        slackUser: event.user,
        durationMs: Date.now() - startedAt,
        errorCode: error.message,
      });
      throw error;
    } finally {
      if (progressHeartbeat) {
        clearInterval(progressHeartbeat);
      }
    }
  });

  if (position > 0) {
    await progress(`:확인중: 앞선 요청을 처리하고 있습니다. 대기 순서: ${position}번\n작업을 시작하면 알려드리겠습니다.\n_확인 ID: ${requestId}_`, { force: true });
  }

  try {
    const answer = await promise;
    await updateMessage(client, progressMessage, formatForSlack(answer.text));
    await setStatusReaction(client, event, answer.status === 'failed' ? 'failed' : answer.status === 'needs_input' ? 'received' : 'completed');
  } catch {
    await updateMessage(client, progressMessage, [
      ':alert-red: *요청 처리 실패*',
      '요청을 처리하는 중 문제가 발생했습니다. 확인 ID로 실행 기록을 찾을 수 있습니다.',
      '',
      '*다음 조치*',
      '• 잠시 후 같은 요청을 다시 남겨주세요.',
      '',
      `_확인 ID: ${requestId}_`,
    ].join('\n'));
    await setStatusReaction(client, event, 'failed');
  }
}

function startAgentProgressHeartbeat(progress, requestId, startedAt) {
  return setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    progress([
      ':loading: 아직 처리 중입니다. 결과가 나오면 이 메시지를 갱신하겠습니다.',
      `_경과 ${elapsedSeconds}초 · 확인 ID: ${requestId}_`,
    ].join('\n'), { force: true }).catch((error) => {
      console.error(`Failed to update agent progress. requestId=${requestId}:`, error.message);
    });
  }, 30_000);
}

function buildAgentPrompt({ agentInstructions, requestId, requestedEnvironment, text, threadContext }) {
  return [
    agentInstructions,
    '',
    '## 이번 실행',
    `- 확인 ID: ${requestId}`,
    `- 요청에 명시된 환경: ${requestedEnvironment}`,
    '',
    '<slack_request>',
    sanitizeSlackText(text),
    '</slack_request>',
    '',
    '<thread_context>',
    threadContext || '이전 대화 없음',
    '</thread_context>',
  ].join('\n');
}

function createRequestId(event) {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = String(event.ts ?? Date.now()).replace(/\D/g, '').slice(-8).padStart(8, '0');
  return `MODY-${date}-${suffix}`;
}

function startPolling() {
  if (config.pollIntervalMs <= 0) {
    return;
  }

  pollChannelHistoryOnce();

  setInterval(() => {
    pollChannelHistoryOnce();
  }, config.pollIntervalMs);
}

async function pollChannelHistoryOnce() {
  if (pollInProgress) {
    return;
  }

  pollInProgress = true;
  try {
    await pollChannelHistory();
  } catch (error) {
    console.error('Slack polling failed:', error);
  } finally {
    pollInProgress = false;
  }
}

async function pollChannelHistory() {
  const response = await app.client.conversations.history({
    channel: config.errorChannelId,
    limit: 10,
  });
  lastSuccessfulPollAt = Date.now();

  for (const message of [...(response.messages ?? [])].reverse()) {
    await processPolledMessage(message);
  }
}

async function processPolledMessage(message) {
  if (isOwnBotMessage(message) || isUnsupportedMessage(message) || !message.ts) {
    return;
  }
  if (!config.processExistingMessages && Number(message.ts) < startedAtSlackTs) {
    return;
  }

  const event = {
    ...message,
    channel: config.errorChannelId,
  };

  if (isBotMention(message.text)) {
    await processMention(event, app.client, stripBotMention(message.text ?? ''));
    return;
  }

  if (!config.autoAnalyzeErrors) {
    return;
  }

  const parsed = parseServerError(message.text ?? '');
  if (!parsed) {
    return;
  }
  await markAlertEnvironment(app.client, event);
  if (isIgnoredNoise(parsed)) {
    return;
  }

  const key = fingerprint(parsed);
  if (isDuplicate(key) || !await claimAlert(event)) {
    return;
  }

  const progressMessage = await upsertThreadReply(app.client, event, ':loading: 오류 알림을 확인했습니다. 원인을 조사하고 있습니다.');
  await markProcessing(app.client, event);
  const progress = createProgressUpdater(app.client, progressMessage);
  const threadContext = await buildThreadContext(app.client, event, progress);
  const analysis = await analyzeError(parsed, progress, threadContext);
  const resultText = `:완료: *오류 조사 결과*\n${formatForSlack(renderErrorAnalysis(parsed, analysis))}`;
  await updateMessage(app.client, progressMessage, resultText);
  await linkErrorIssue(app.client, event, parsed, key, analysis, progressMessage, resultText);
  await markAnswered(app.client, event);
}

function startSlackWatchdog() {
  if (config.slackWatchdogMs <= 0) {
    return;
  }

  setInterval(() => {
    const staleForMs = Date.now() - lastSuccessfulPollAt;
    if (staleForMs < config.slackWatchdogMs) {
      return;
    }

    console.error(`Slack polling has been unavailable for ${staleForMs}ms. Restarting process.`);
    process.exit(1);
  }, Math.min(config.slackWatchdogMs, 30_000));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function stripBotMention(text) {
  return stripSlackMentions(text);
}

function isBotMention(text) {
  return Boolean(botUserId && text?.includes(`<@${botUserId}>`));
}

async function getBotIdentity() {
  const response = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${config.slackBotToken}` },
  });
  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Slack auth.test failed: ${result.error}`);
  }
  return { userId: result.user_id, botId: result.bot_id };
}

function isSecretReadRequest(text) {
  return /(env|환경변수|secret|token|토큰|비밀|credentials?|키).*(읽|보여|출력|공유)|(\.env|application\.ya?ml).*(읽|보여|출력|공유)/i.test(text);
}

function isFixCommand(text) {
  return /^fix\b/i.test(text.trim());
}

function isWriteRequest(text) {
  const normalized = text.trim();
  return isFixCommand(normalized)
    || /(?:PR|풀리퀘|pull request).*(?:열|만들|생성|올려|작성)/i.test(normalized)
    || /(?:데이터|DB|디비|데이터베이스|dev|데브|개발).*(?:보정|수정|삭제|생성|추가|넣어|업데이트|반영)/i.test(normalized)
    || /(?:보정|수정|삭제|생성|추가|업데이트|배포|머지|커밋).*(?:해|하|진행|실행|부탁)/i.test(normalized);
}

function isDataCorrectionRequest(text) {
  const normalized = text.trim();
  return /(?:dev|데브|개발|데이터|DB|디비|데이터베이스|기록|걸음수|챌린지).*(?:보정|수정|삭제|생성|추가|넣어|업데이트|반영)/i.test(normalized)
    || /(?:보정|수정|삭제|생성|추가|넣어|업데이트|반영).*(?:dev|데브|개발|데이터|DB|디비|데이터베이스|기록|걸음수|챌린지)/i.test(normalized);
}

function isDataReadRequest(text) {
  return isMemberNicknameLookupRequest(text)
    || /(?:dev|데브|개발|prod|prd|운영)(?:\s*서버)?|(?:(?:dev|데브|개발|prod|prd|운영)\s*(?:DB|디비|데이터베이스))/.test(text)
      && /(?:조회|확인|봐|보여|알려|읽|파악|살펴|체크|대조)/i.test(text)
    || /(?:데이터|DB|디비|데이터베이스).*(?:조회|확인|봐|보여|알려|읽|파악|살펴|체크|대조)/i.test(text);
}

function isMemberNicknameLookupRequest(text) {
  const hasMemberId = /\b\d{10,}\b/.test(text)
    && /(?:member\s*id|memberid|회원\s*id|멤버\s*id)/i.test(text);
  const asksForNickname = /(?:닉네임|이름).*(?:조회|확인|봐|보여|알려|찾)/i.test(text)
    || /(?:조회|확인|봐|보여|알려|찾).*(?:닉네임|이름)/i.test(text);

  return hasMemberId && asksForNickname;
}

function renderHealthReply() {
  const secondsSincePoll = Math.floor((Date.now() - lastSuccessfulPollAt) / 1000);
  const pollingStatus = secondsSincePoll < config.slackWatchdogMs / 1000
    ? `정상 (마지막 Slack 채널 확인 ${secondsSincePoll}초 전)`
    : '확인 중';
  return [
    '*모디 봇 상태*',
    `• 하네스: 실행 중`,
    `• Slack 채널 확인: ${pollingStatus}`,
    `• 자동 500 분석: ${config.autoAnalyzeErrors ? '활성화' : '비활성화'}`,
    `• 작업 큐: 실행 ${requestQueue.activeCount}건 / 대기 ${requestQueue.pendingCount}건`,
    '문제가 있으면 이 thread에 바로 남겨주세요.',
  ].join('\n');
}

function renderVersionReply() {
  return [
    '*이전 버전과 달라진 점*',
    '• 하나의 요청에서 코드·dev·prod·서버 상태를 함께 확인합니다.',
    '• 복합 요청을 작업으로 나누고, 결과를 교차 검증한 뒤 답합니다.',
    '• 같은 thread의 이전 대화를 이어서 후속 요청을 처리합니다.',
    '• 결과를 결론·확인 결과·판단·다음 조치 형식으로 일관되게 제공합니다.',
    '• 오래 걸리는 작업은 30초마다 조사 단계와 경과 시간을 갱신합니다.',
    '• 작업 큐, 요청별 확인 ID, 감사 기록, 구조화된 결과 검증이 추가됐습니다.',
    '• 상태·사용법·버전 차이 같은 봇 자체 질문은 즉시 답합니다.',
  ].join('\n');
}

async function handlePrivilegedOperation(client, event, text) {
  const progressMessage = await upsertThreadReply(client, event, '요청 범위와 현재 상태를 확인하고 있습니다.');
  await markProcessing(client, event);

  if (!config.enablePrivilegedOperations) {
    await updateMessage(client, progressMessage, 'dev 데이터 보정 실행이 현재 비활성화되어 있습니다.');
    await markAnswered(client, event);
    return;
  }

  const prompt = [
    'Slack에서 전달된 MODY dev 데이터 보정 요청을 직접 처리한다.',
    'dev 서버 관련 요청은 $mody-dev-operations 스킬의 SSH, Docker, DB 절차를 따라 직접 실행한다.',
    '데이터 변경은 먼저 정확한 대상 수를 조회하고, 최소 범위로 변경한 뒤 같은 조건으로 결과를 검증한다.',
    '코드 수정, 커밋, PR 생성, 머지, 배포는 절대 하지 않는다.',
    '범위가 부족해 안전하게 실행할 수 없으면 필요한 정보만 짧게 질문하고 변경하지 않는다.',
    'Slack 최종 답변은 비개발자도 이해할 수 있게 처리 결과, 확인 수치, 남은 조치만 800자 이내로 작성한다. 코드, API, DB, 파일 경로, 서버 주소, 명령어, 비밀값, 내부 실패 내용은 제외한다.',
    '작업 요청:',
    text,
  ].join('\n');

  const result = await runCodexOperation(prompt);
  await updateMessage(client, progressMessage, result ?? '요청 결과를 확인하지 못했습니다.');
  await markAnswered(client, event);
}

function resolveReadEnvironment(text) {
  return /(?:prod|prd|운영)/i.test(text) ? 'prod' : 'dev';
}

async function handleDataReadRequest(client, event, text) {
  const environment = resolveReadEnvironment(text);
  const progressMessage = await upsertThreadReply(client, event, `${environment} 상태를 확인하고 있습니다.`);
  await markProcessing(client, event);
  const prompt = [
    `Slack에서 전달된 MODY ${environment} 읽기 요청을 처리한다.`,
    '반드시 $mody-operations 스킬의 SSH, Docker, DB 절차를 따른다.',
    '조회만 수행한다. 데이터 변경, 배포, 서비스 재시작, PR 생성, 머지는 절대 하지 않는다.',
    'Slack 최종 답변은 비개발자도 이해할 수 있게 확인 결과와 필요한 다음 조치만 800자 이내로 작성한다. 코드, API, DB, 파일 경로, 서버 주소, 명령어, 비밀값, 내부 실패 내용은 제외한다.',
    '요청:',
    text,
  ].join('\n');
  const result = await runCodexOperation(prompt);
  await updateMessage(client, progressMessage, result ?? '현재 확인 결과를 정리하지 못했습니다.');
  await markAnswered(client, event);
}

function parseServerError(text) {
  const status = matchAlertField(text, 'Status');
  const request = matchAlertField(text, 'Request');
  const exception = matchAlertField(text, 'Exception');
  const message = matchAlertField(text, 'Message');
  const stack = text.split(/\*{1,2}Stack\*{1,2}|_Stack_|Stack:/)[1]?.trim() ?? '';
  const requestParts = request?.match(/([A-Z]+)\s+(\S+)/);

  if (!status && !exception && !request) {
    return null;
  }

  return {
    status: status ?? 'unknown',
    request: request ?? 'unknown',
    method: requestParts?.[1],
    path: requestParts?.[2],
    exception: exception ?? 'unknown',
    message: message ?? '',
    stack,
  };
}

function matchAlertField(text, field) {
  return matchLine(text, new RegExp(`(?:\\*{1,2}|_)?${field}(?:\\*{1,2}|_)?\\s*:\\s*([^\\n]+)`, 'i'));
}

function matchLine(text, regex) {
  return text.match(regex)?.[1]?.trim();
}

function isIgnoredNoise(error) {
  // MODY API does not accept multipart uploads; these are malformed scanner requests.
  if (error.exception?.includes('MultipartException')) {
    return true;
  }

  if (error.path === '/v3/api-docs'
    && (error.exception?.includes('AsyncRequestNotUsableException') || /broken pipe/i.test(error.message))) {
    return true;
  }

  const ignoredPaths = [
    '/favicon.ico',
    '/robots.txt',
    '/.env',
    '/',
    '/wp-admin',
    '/wp-login.php',
    '/actuator',
  ];

  return ignoredPaths.some((ignoredPath) => error.path === ignoredPath || error.path?.startsWith(`${ignoredPath}/`));
}

function fingerprint(error) {
  return [error.method, error.path, error.exception, firstStackFrame(error.stack)].filter(Boolean).join('|');
}

function firstStackFrame(stack) {
  return stack.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

function isDuplicate(key) {
  const now = Date.now();
  const ttlMs = 30 * 60 * 1000;
  for (const [storedKey, timestamp] of recentlyHandled.entries()) {
    if (now - timestamp > ttlMs) {
      recentlyHandled.delete(storedKey);
    }
  }
  if (recentlyHandled.has(key)) {
    return true;
  }
  recentlyHandled.set(key, now);
  return false;
}

// 오류마다 GitHub 이슈를 보장한다. 같은 오류의 이슈가 열려 있으면 새로 만들지 않는다.
// 이슈 처리가 실패해도 Slack 분석 흐름은 막지 않는다.
async function linkErrorIssue(client, event, parsed, key, analysis, progressMessage, resultText) {
  if (!config.autoCreateIssues) {
    return;
  }

  try {
    let slackLink = null;
    try {
      const permalink = await client.chat.getPermalink({ channel: event.channel, message_ts: event.ts });
      slackLink = permalink.permalink ?? null;
    } catch (error) {
      console.error('Failed to get Slack permalink:', error?.data?.error ?? error);
    }

    const issue = await ensureErrorIssue({
      repo: config.githubRepo,
      ghPath: config.ghPath,
      labels: config.issueLabels,
      cacheFile: config.issueCacheFile,
      fingerprint: key,
      error: parsed,
      environment: alertEnvironment(event.text),
      analysisText: renderErrorAnalysis(parsed, analysis),
      slackLink,
    });

    const line = issue.status === 'created'
      ? `📌 GitHub 이슈를 만들었습니다: <${issue.url}|#${issue.number}>`
      : `📌 같은 오류로 열린 이슈가 있어 새로 만들지 않았습니다: <${issue.url}|#${issue.number}>`;
    await updateMessage(client, progressMessage, `${resultText}\n\n${line}`);
    console.log(`[issue] ${issue.status} #${issue.number} for ${key}`);
  } catch (error) {
    console.error('Failed to create GitHub issue for error alert:', error?.stderr ?? error);
  }
}

async function claimAlert(event) {
  const claimPath = path.join(
    config.handledAlertDirectory,
    Buffer.from(`${event.channel}:${event.ts}`).toString('base64url'),
  );

  try {
    await mkdir(config.handledAlertDirectory, { recursive: true });
    await writeFile(claimPath, '', { flag: 'wx' });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return false;
    }
    console.error('Failed to claim Slack error alert:', error);
    return false;
  }
}

async function analyzeError(error, progress, threadContext = '') {
  if (config.useCodexAnalysis) {
    await progress?.('로컬 코드베이스를 읽고 있습니다. 답변이 준비되면 이 댓글을 갱신하겠습니다.');
    const codexAnalysis = await analyzeErrorWithCodex(error, progress, threadContext);
    if (codexAnalysis) {
      return codexAnalysis;
    }
  }

  const queries = [
    error.exception?.split('.').at(-1),
    error.path,
    error.message,
    error.status?.match(/[A-Z]+[0-9]+/)?.[0],
  ].filter(Boolean);

  const results = [];
  for (const query of queries) {
    await progress?.('코드 검색 결과를 정리하고 있습니다.');
    results.push(...await searchRepo(query));
  }

  return {
    hypothesis: buildHypothesis(error),
    matches: uniqueMatches(results).slice(0, 8),
  };
}

async function answerRepositoryQuestion(question, progress, threadContext = '') {
  if (config.useCodexAnalysis) {
    await progress?.('로컬 코드베이스를 읽고 있습니다. 답변이 준비되면 이 댓글을 갱신하겠습니다.');
    const codexAnswer = await answerRepositoryQuestionWithCodex(question, progress, threadContext);
    if (codexAnswer) {
      return codexAnswer;
    }
  }

  const keywords = extractKeywords(question);
  if (keywords.length === 0) {
    return '질문에서 검색할 키워드를 찾지 못했습니다. API 경로, 예외 코드, 클래스명 중 하나를 같이 적어주세요.';
  }

  const results = [];
  for (const keyword of keywords.slice(0, 5)) {
    await progress?.('코드 검색 결과를 정리하고 있습니다.');
    results.push(...await searchRepo(keyword));
  }

  const matches = uniqueMatches(results).slice(0, 10);
  if (matches.length === 0) {
    return [
      '아직 코드에서 확실한 위치를 찾지 못했습니다.',
      '질문에 API 주소, 화면 이름, 에러 코드 중 하나를 같이 적어주면 더 정확히 찾아볼 수 있습니다.',
      `제가 먼저 확인해본 단서: ${keywords.join(', ')}`,
    ].join('\n');
  }

  return [
    '정확한 설명을 만들기 전, 먼저 확인해볼 만한 코드 위치를 찾았습니다.',
    '아래는 최종 결론이 아니라 제가 다음으로 읽어볼 후보입니다.',
    '',
    renderMatches(matches),
  ].join('\n');
}

async function analyzeErrorWithCodex(error, progress, threadContext = '') {
  const prompt = [
    '너는 MODY 운영 지원 assistant다.',
    '사용자가 Slack 에러 thread에서 바로 읽을 답변을 작성한다. 독자는 백엔드 개발자가 아닌 팀원이다.',
    '',
    '규칙:',
    '- 코드를 직접 읽고 판단한다. 단순 검색 결과 나열로 끝내지 않는다.',
    '- 한국어 자연어로 친절하게 설명한다. 전문 용어는 필요한 만큼만 쓰고, 쓰면 짧게 풀어쓴다.',
    '- 첫 문장은 `결론:`으로 시작하며, 확인된 사실만 한 문장으로 말한다.',
    '- 사용자 영향, 원인, 다음 조치는 필요한 항목만 짧게 덧붙인다. 모두 채우기 위해 반복하거나 추측을 늘어놓지 않는다.',
    '- 대응은 `데이터 확인/보정`, `기능 수정`, `외부 서비스 확인`, `추가 확인 필요`처럼 사용자가 이해할 표현으로 분류한다.',
    '- 데이터 보정 가능성이 있으면 확인할 조건과 예상 영향만 적고, 실행 명령이나 조회 방법은 적지 않는다.',
    '- 기능 수정 가능성이 있으면 어떤 사용자 경험을 고쳐야 하는지만 적고, API·파일·클래스·구현 조건은 적지 않는다.',
    '- 외부 서비스 문제 가능성이 있으면 어떤 연동을 확인해야 하는지만 적고, 설정 키·네트워크·저장소 같은 구현 세부사항은 적지 않는다.',
    '- 실제 DB 데이터나 배포 로그를 읽지 못한 경우에는 건수와 실제 영향 범위를 확정하지 말고, 확인이 필요하다고 명시한다.',
    '- 확실하지 않은 내용은 추정이라고 표시하고, 가능한 원인 목록은 최대 한 개만 제시한다.',
    '- secrets, .env 원문, 토큰 값은 절대 출력하지 않는다.',
    '- 현재 dev 데이터나 서버 상태를 확인해야 답변 정확도가 확보되는 경우에는 $mody-dev-operations 스킬의 SSH, Docker, DB 절차로 읽기 전용 조회를 직접 수행한다. 필요하지 않으면 로컬 코드만 확인한다.',
    '- dev 데이터 생성·수정, 코드 수정, 커밋, PR 생성, 머지, 배포는 절대 하지 않는다.',
    '- 코드 수정, 커밋, PR 생성, 배포는 하지 않는다.',
    '- 답변은 Slack thread에 들어갈 텍스트이므로 700자 이내로 작성한다.',
    '- Slack mrkdwn 형식으로 작성한다. Markdown 제목(##, ###), 표, GitHub 파일 링크는 쓰지 않는다.',
    '- 필요한 경우에만 *현재 상황*, *영향*, *다음 조치*의 짧은 섹션을 쓴다. 참고 근거 섹션은 만들지 않는다.',
    '',
    '에러 정보:',
    `Status: ${error.status}`,
    `Request: ${error.request}`,
    `Exception: ${error.exception}`,
    `Message: ${error.message}`,
    `Top stack: ${firstStackFrame(error.stack)}`,
    '',
    'Slack thread 맥락:',
    threadContext || '이전 대화 없음',
  ].join('\n');

  const result = await runCodexReadOnly(prompt, progress);
  if (!result) {
    return null;
  }

  return {
    codexText: result,
    hypothesis: '',
    matches: [],
  };
}

async function answerRepositoryQuestionWithCodex(question, progress, threadContext = '') {
  const context = await buildQuestionContext(question, progress);
  const prompt = [
    '너는 MODY 기능 지원 assistant다.',
    'Slack 멘션 질문에 답한다. 독자는 백엔드 개발자가 아닌 팀원이다.',
    '',
    '규칙:',
    '- 아래 코드베이스 컨텍스트를 출발점으로 삼고, 필요하면 로컬 레포를 추가로 읽어서 답한다.',
    '- 단순 파일 목록을 나열하지 않는다.',
    '- 한국어 자연어로 쉽게 설명한다. 코드, API, DB, 파일 경로, 클래스명, 구현 방식은 사용자가 직접 물어보지 않는 한 언급하지 않는다.',
    '- 답변 순서는 결론 → 사용자가 보게 되는 결과 → 필요한 다음 조치 순서로 작성한다.',
    '- 확실하지 않은 내용은 추정이라고 표시한다.',
    '- secrets, .env 원문, 토큰 값은 절대 출력하지 않는다.',
    '- SSH, dev 서버, DB, 네트워크 접근을 직접 시도하거나 실행 환경의 권한/네트워크 실패를 Slack 답변에 적지 않는다.',
    '- dev 데이터 생성·수정 요청은 하네스의 확인 및 실행 흐름이 담당한다. 이 분석 답변에서는 실행 불가 사유나 수동 명령을 안내하지 않는다.',
    '- 코드 수정, 커밋, PR 생성, 배포는 하지 않는다.',
    '- 답변은 Slack thread에 들어갈 텍스트이므로 1200자 이내로 작성한다.',
    '- Slack mrkdwn 형식으로 작성한다. Markdown 제목(##, ###), 표, GitHub 파일 링크는 쓰지 않는다.',
    '- 필요한 경우에만 *결론*, *영향*, *다음 조치*의 짧은 섹션을 쓴다. 참고 근거 섹션은 만들지 않는다.',
    '',
    '코드베이스 컨텍스트:',
    context || '관련 컨텍스트를 충분히 찾지 못했습니다.',
    '',
    'Slack thread 맥락:',
    threadContext || 'thread 맥락 없음',
    '',
    '질문:',
    question,
  ].join('\n');

  return await runCodexOperation(prompt);
}

async function summarizeThread(question, threadContext, progress) {
  await progress?.('thread 내용을 읽고 요약하고 있습니다.');
  const prompt = [
    '너는 Slack thread 내용을 읽고 팀원이 바로 이해할 수 있게 요약하는 assistant다.',
    '',
    '규칙:',
    '- 한국어 자연어로 친절하게 요약한다.',
    '- 결론/현재 합의/남은 확인 사항/다음 액션을 구분한다.',
    '- 누가 무슨 말을 했는지보다 결정된 내용과 해야 할 일을 우선한다.',
    '- thread에 없는 내용은 추정하지 말고 "아직 확인 필요"라고 적는다.',
    '- secrets, .env 원문, 토큰 값은 절대 출력하지 않는다.',
    '- 2000자 이내로 답한다.',
    '- Slack mrkdwn 형식으로 작성한다. Markdown 제목(##, ###), 표, GitHub 링크 문법은 쓰지 않는다.',
    '- 섹션 제목은 *결론*, *현재 합의*, *남은 확인 사항*, *다음 액션*처럼 굵게 표시한다.',
    '',
    '요청:',
    question,
    '',
    'Slack thread 내용:',
    threadContext || 'thread에서 읽을 수 있는 이전 메시지가 없습니다.',
  ].join('\n');

  const result = await runCodexReadOnly(prompt, progress);
  return result || 'thread 내용을 읽었지만 요약을 만들지 못했습니다. 조금 더 구체적으로 다시 요청해주세요.';
}

async function runCodexReadOnly(prompt, progress) {
  await progress?.('로컬 코드베이스를 읽고 있습니다. 답변이 준비되면 이 댓글을 갱신하겠습니다.');
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'mody-codex-'));
  const outputPath = path.join(outputDir, 'last-message.txt');
  const progressTimer = startCodexProgressTimer(progress);
  const result = await runCodexCommand(prompt, outputPath);
  if (progressTimer) {
    clearInterval(progressTimer);
  }

  let lastMessage = '';
  try {
    lastMessage = await readFile(outputPath, 'utf8');
  } catch {
    lastMessage = '';
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }

  if (result.exitCode !== 0 || !lastMessage.trim()) {
    console.error('Codex read-only analysis failed:', trimOutput(result.stderr || result.stdout));
    return null;
  }

  return trimSlackText(lastMessage.trim());
}

async function runCodexOperation(prompt, options = {}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'mody-codex-operation-'));
  const outputPath = path.join(outputDir, 'last-message.txt');
  const modelArg = config.codexAnalysisModel ? `-m ${shellQuote(config.codexAnalysisModel)}` : '';
  const reasoningArg = shellQuote(`model_reasoning_effort="${config.codexReasoningEffort}"`);
  const sandboxArgs = options.privileged
    ? ['--sandbox danger-full-access', '--dangerously-bypass-approvals-and-sandbox']
    : ['--sandbox read-only'];
  const command = [
    'codex exec',
    modelArg,
    `-c ${reasoningArg}`,
    '--cd "$MODY_REPO_PATH"',
    ...sandboxArgs,
    options.outputSchemaPath ? '--output-schema "$CODEX_OUTPUT_SCHEMA_PATH"' : '',
    '--output-last-message "$CODEX_OUTPUT_PATH"',
    '"$CODEX_PROMPT"',
    '</dev/null',
  ].filter(Boolean).join(' ');
  const result = await runCommand('/bin/zsh', ['-lc', command], {
    timeoutMs: config.agentTimeoutMs,
    env: buildSafeChildEnvironment(process.env, {
      CODEX_PROMPT: prompt,
      CODEX_OUTPUT_PATH: outputPath,
      CODEX_OUTPUT_SCHEMA_PATH: options.outputSchemaPath ?? '',
      MODY_REPO_PATH: config.repoPath,
    }),
  });

  let lastMessage = '';
  try {
    lastMessage = await readFile(outputPath, 'utf8');
  } catch {
    lastMessage = '';
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }

  if (result.exitCode !== 0 || !lastMessage.trim()) {
    console.error('Codex privileged operation failed:', trimOutput(result.stderr || result.stdout));
    return null;
  }

  return trimSlackText(lastMessage.trim());
}

async function runCodexCommand(prompt, outputPath) {
  const modelArg = config.codexAnalysisModel ? `-m ${shellQuote(config.codexAnalysisModel)}` : '';
  const reasoningArg = shellQuote(`model_reasoning_effort="${config.codexReasoningEffort}"`);
  const command = [
    'codex exec',
    modelArg,
    `-c ${reasoningArg}`,
    '--cd "$MODY_REPO_PATH"',
    '--sandbox read-only',
    '--output-last-message "$CODEX_OUTPUT_PATH"',
    '"$CODEX_PROMPT"',
    '</dev/null',
  ].filter(Boolean).join(' ');

  return await runCommand('/bin/zsh', ['-lc', command], {
    timeoutMs: config.codexAnalysisTimeoutMs,
    env: buildSafeChildEnvironment(process.env, {
      CODEX_PROMPT: prompt,
      CODEX_OUTPUT_PATH: outputPath,
      MODY_REPO_PATH: config.repoPath,
    }),
  });
}

function startCodexProgressTimer(progress) {
  if (!progress) {
    return null;
  }

  const checkpoints = [
    '생각보다 오래 걸리고 있습니다. 관련 코드와 문서를 조금 더 확인하고 있습니다.',
    '답변을 정리하고 있습니다.',
  ];
  let index = 0;
  return setInterval(() => {
    if (index >= checkpoints.length) {
      return;
    }
    progress(checkpoints[index]);
    index += 1;
  }, 30_000);
}

function extractKeywords(question) {
  const candidates = [
    ...question.matchAll(/[A-Z][A-Z0-9_]{2,}/g),
    ...question.matchAll(/\/[A-Za-z0-9/_{}?-]+/g),
    ...question.matchAll(/[A-Za-z][A-Za-z0-9]*(Controller|Service|Repository|Exception|Status|Request|Response)/g),
    ...question.matchAll(/[가-힣A-Za-z0-9]{3,}/g),
  ].map((match) => match[0]);

  const stopWords = new Set([
    'API',
    'api',
    '로직',
    '흐름',
    '관련',
    '위치',
    '어디서',
    '어떻게',
    '왜',
    '나는지',
    '봐줘',
    '알려줘',
    '확인',
    '수정',
    '고쳐',
  ]);
  return [...new Set(candidates.filter((word) => !stopWords.has(word)))];
}

async function buildQuestionContext(question, progress) {
  await progress?.('로컬 코드베이스를 읽고 있습니다. 답변이 준비되면 이 댓글을 갱신하겠습니다.');
  const files = await collectRepositoryFiles(config.repoPath);
  const keywords = extractKeywords(question);
  const hints = detectDomainHints(question);
  const rankedFiles = files
    .map((file) => ({ file, score: scoreContextFile(file, keywords, hints) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const sections = [];
  for (const { file } of rankedFiles) {
    const absolutePath = path.join(config.repoPath, file);
    try {
      const content = await readFile(absolutePath, 'utf8');
      sections.push([
        `--- ${file} ---`,
        trimContextContent(content),
      ].join('\n'));
    } catch {
      // Ignore files that disappeared while the harness is running.
    }
  }

  return sections.join('\n\n');
}

async function collectRepositoryFiles(root) {
  const results = [];
  await collectFiles(root, results);
  return results
    .map((file) => path.relative(root, file))
    .filter((file) => isContextFile(file));
}

async function collectFiles(directory, results) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ['build', 'node_modules', 'out', 'dist'].includes(entry.name)) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolutePath, results);
    } else {
      results.push(absolutePath);
    }
  }
}

function isContextFile(file) {
  return /\.(java|md|yaml|yml|kts)$/.test(file)
    && !file.includes('/generated-snippets/')
    && !file.includes('/build/');
}

function detectDomainHints(question) {
  const mappings = [
    { pattern: /온보딩|onboarding/i, hints: ['src/main/java/cmc/mody/onboarding', 'src/test/java/cmc/mody/onboarding', 'docs/lld', 'docs/adr'] },
    { pattern: /인증|로그인|토큰|oauth|소셜|auth/i, hints: ['src/main/java/cmc/mody/auth', 'src/main/java/cmc/mody/member', 'docs/lld', 'docs/adr'] },
    { pattern: /그룹|group/i, hints: ['src/main/java/cmc/mody/group', 'src/test/java/cmc/mody/group', 'docs/lld', 'docs/adr'] },
    { pattern: /알림|notification|fcm/i, hints: ['src/main/java/cmc/mody/notification', 'src/test/java/cmc/mody/notification', 'docs/lld', 'docs/adr'] },
    { pattern: /마이페이지|mypage|프로필|체중/i, hints: ['src/main/java/cmc/mody/mypage', 'src/main/java/cmc/mody/member', 'src/test/java/cmc/mody/mypage'] },
    { pattern: /기록|피드|식사|운동|record|feed/i, hints: ['src/main/java/cmc/mody/record', 'src/main/java/cmc/mody/feed', 'src/test/java/cmc/mody/record', 'src/test/java/cmc/mody/feed'] },
    { pattern: /챌린지|challenge/i, hints: ['src/main/java/cmc/mody/challenge', 'src/test/java/cmc/mody/challenge', 'docs/lld', 'docs/adr'] },
    { pattern: /예외|에러|ErrorStatus|exception/i, hints: ['src/main/java/cmc/mody/common', 'src/test/java/cmc/mody/docs'] },
  ];

  return mappings
    .filter((mapping) => mapping.pattern.test(question))
    .flatMap((mapping) => mapping.hints);
}

function scoreContextFile(file, keywords, hints) {
  let score = 0;
  for (const hint of hints) {
    if (file.startsWith(hint)) {
      score += 12;
    }
  }
  for (const keyword of keywords) {
    if (file.toLowerCase().includes(keyword.toLowerCase())) {
      score += 6;
    }
  }
  if (/Controller\.java$/.test(file)) {
    score += 8;
  }
  if (/Service\.java$/.test(file)) {
    score += 7;
  }
  if (/Repository\.java$/.test(file)) {
    score += 3;
  }
  if (/DocsTest\.java$/.test(file)) {
    score += 4;
  }
  if (/ErrorStatus\.java$/.test(file)) {
    score += 5;
  }
  if (file.startsWith('src/main/resources')) {
    score -= 8;
  }
  if (file === 'README.md' || file === 'AGENTS.md' || file === 'build.gradle.kts') {
    score -= 12;
  }
  return score;
}

function trimContextContent(content) {
  const normalized = content
    .split('\n')
    .filter((line) => !line.trim().startsWith('import '))
    .join('\n');
  return normalized.length <= 2500 ? normalized : `${normalized.slice(0, 2500)}\n...`;
}

async function searchRepo(rawQuery) {
  const query = normalizeQuery(rawQuery);
  if (!query) {
    return [];
  }

  const result = await runCommand('rg', [
    '--line-number',
    '--no-heading',
    '--smart-case',
    '--glob',
    '!build/**',
    '--glob',
    '!node_modules/**',
    query,
    config.repoPath,
  ]);

  return parseRgOutput(result.stdout);
}

function normalizeQuery(query) {
  return String(query)
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[{}[\]()*+?.\\^$|]/g, '')
    .trim();
}

function parseRgOutput(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (!match) {
        return null;
      }
      return {
        file: path.relative(config.repoPath, match[1]),
        line: Number(match[2]),
        text: match[3].trim(),
      };
    })
    .filter(Boolean);
}

function uniqueMatches(matches) {
  const seen = new Set();
  return matches.filter((match) => {
    const key = `${match.file}:${match.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildHypothesis(error) {
  if (error.exception.includes('NoResourceFoundException')) {
    return '정적 리소스 또는 정의되지 않은 경로 요청이 Spring resource handler까지 도달한 케이스로 보입니다. API 장애보다는 스캐너/브라우저 기본 요청일 가능성이 큽니다.';
  }
  if (/Validation|MethodArgumentNotValid|BindException/.test(error.exception)) {
    return '요청 DTO validation 또는 바인딩 규칙에서 거절된 케이스로 보입니다. Swagger 예시와 DTO 제약 조건을 같이 확인해야 합니다.';
  }
  if (/DataIntegrity|Constraint|Duplicate|IncorrectResult/.test(error.exception)) {
    return 'DB 제약 조건 또는 조회 결과 개수 불일치 가능성이 큽니다. unique 조건, soft delete 조건, repository 쿼리를 우선 확인해야 합니다.';
  }
  if (/Feign|OAuth|RestClient|HttpClient/.test(error.exception + error.message)) {
    return '외부 API 연동 실패 가능성이 있습니다. provider 응답 코드, 환경변수, Feign client 설정을 확인해야 합니다.';
  }
  return '예외 타입과 요청 경로 기준으로 관련 컨트롤러, 서비스, 공통 예외 처리 로직을 우선 확인해야 합니다.';
}

function renderErrorAnalysis(error, analysis) {
  if (analysis.codexText) {
    return analysis.codexText;
  }

  return [
    '*현재 상황*',
    '요청 처리 중 문제가 발생했습니다. 아래 정보만으로는 정확한 사용자 영향과 원인을 확정하기 어렵습니다.',
    '',
    '*다음 조치*',
    '영향 범위와 재현 조건을 먼저 확인하겠습니다. 같은 문제가 반복되면 발생 시점과 사용자가 수행한 행동을 이 thread에 남겨주세요.',
  ].filter(Boolean).join('\n');
}

function renderMatches(matches) {
  return matches
    .map((match) => `- \`${match.file}:${match.line}\` ${truncate(match.text, 140)}`)
    .join('\n');
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function codeBlock(value) {
  return ['```', value, '```'].join('\n');
}

function trimOutput(value) {
  const trimmed = value.trim();
  return trimmed.length <= 3000 ? trimmed : `${trimmed.slice(-3000)}\n...`;
}

function trimSlackText(value) {
  const trimmed = value.trim();
  return trimmed.length <= 2800 ? trimmed : `${trimmed.slice(0, 2800)}\n...`;
}

function formatForSlack(value) {
  return trimSlackText(String(value)
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\[([^\]]+)]\((?:\/Users\/minseokkim\/Desktop\/Code\/mody-server\/)?([^)]+)\)/g, '`$2`')
    .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, '<$2|$1>')
    .replace(/^\s{0,3}[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function upsertThreadReply(client, event, text) {
  return await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.thread_ts ?? event.ts,
    ...slackMessage(text),
  });
}

async function getThreadReplies(client, channel, threadTs) {
  try {
    const response = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20,
    });
    return response.messages ?? [];
  } catch (error) {
    console.error('Failed to read thread replies:', error?.data?.error ?? error.message);
    return [];
  }
}

async function buildThreadContext(client, event, progress) {
  const threadTs = event.thread_ts ?? event.ts;
  const messages = await getThreadReplies(client, event.channel, threadTs);
  const relevantMessages = messages
    .filter((message) => message.ts !== event.ts)
    .filter((message) => !isProgressText(message.text))
    .filter((message) => message.text)
    .slice(-30);

  if (relevantMessages.length === 0) {
    return '';
  }

  await progress?.('thread의 이전 대화도 같이 읽고 있습니다.');
  return relevantMessages
    .map((message) => {
      const speaker = isOwnBotMessage(message)
        ? '모디 봇'
        : message.bot_id ? '외부 봇' : (message.user ? `<@${message.user}>` : 'unknown');
      return `${speaker}: ${sanitizeSlackText(message.text)}`;
    })
    .join('\n');
}

function sanitizeSlackText(text = '') {
  return text
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '[redacted-token]')
    .replace(/xapp-[A-Za-z0-9-]+/g, '[redacted-token]')
    .slice(0, 4000);
}

function isOwnBotMessage(message) {
  return message.user === botUserId || (botId && message.bot_id === botId);
}

function isUnsupportedMessage(message) {
  return Boolean(message.subtype && message.subtype !== 'bot_message');
}

function isProgressText(text = '') {
  text = stripStatusEmoji(text);
  return text.startsWith('읽었습니다.')
    || text.startsWith('요청을 접수했습니다.')
    || text.startsWith('작업을 시작했습니다.')
    || text.startsWith('앞선 요청을 처리하고 있습니다.')
    || text.startsWith('아직 처리 중입니다.')
    || text.startsWith('오류 알림을 확인했습니다.')
    || text.startsWith('스레드 대화를 읽고 요약하고 있습니다.')
    || text.startsWith('요청을 등록했습니다.')
    || text.startsWith('요청을 분석했습니다.')
    || text.startsWith('조사를 계속하고 있습니다.')
    || text.includes('확인하는 중입니다');
}

async function deleteOwnMessage(client, channel, ts) {
  try {
    await client.chat.delete({ channel, ts });
  } catch (error) {
    console.error('Failed to delete duplicate bot reply:', error?.data?.error ?? error.message);
  }
}

async function updateMessage(client, message, text) {
  if (!message?.channel || !message?.ts) {
    return;
  }

  await client.chat.update({
    channel: message.channel,
    ts: message.ts,
    ...slackMessage(text),
  });
}

function createProgressUpdater(client, message) {
  let updateCount = 0;
  let lastText = message?.text ?? '';
  let lastUpdatedAt = 0;

  return async (text, options = {}) => {
    if (text && !/^:(?:loading|확인중|완료|alert-red):/.test(text)) {
      text = `:loading: ${text}`;
    }
    if (!text || text === lastText) {
      return;
    }

    const now = Date.now();
    const isForced = options.force === true;
    const canUpdateInitial = updateCount === 0;
    const canUpdateInterval = now - lastUpdatedAt >= 30_000;
    if (!isForced && !canUpdateInitial && !canUpdateInterval) {
      return;
    }

    await updateMessage(client, message, text);
    lastText = text;
    lastUpdatedAt = now;
    updateCount += 1;
  };
}

async function markAnswered(client, event) {
  await setStatusReaction(client, event, 'completed');
}

async function markProcessing(client, event) {
  await setStatusReaction(client, event, 'running');
}

async function removeReaction(client, event, name) {
  try {
    await client.reactions.remove({
      channel: event.channel,
      timestamp: event.ts,
      name,
    });
  } catch (error) {
    if (error?.data?.error !== 'no_reaction') {
      console.error('Failed to remove reaction:', error?.data?.error ?? error.message);
    }
  }
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: config.repoPath,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: 1024 * 1024 * 5,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
      exitCode: error.code ?? 1,
    };
  }
}
