const HOST_FILE_PATTERNS = [
  /(?:Desktop|Documents|Downloads|Pictures|Movies|Music|Library|Applications)(?:\/|\s|에서|안에)/i,
  /(?:내\s*)?(?:로컬|컴퓨터|맥북|노트북|홈\s*디렉토리).*(?:파일|폴더|정보|찾|읽|보여|검색)/i,
  /(?:파일|폴더).*(?:내\s*)?(?:로컬|컴퓨터|맥북|노트북|홈\s*디렉토리)/i,
  /(?:\/Users\/|~\/|\$HOME|\.ssh|\.aws|\.config|Keychain)/i,
];

export function isHostFileRequest(text) {
  return HOST_FILE_PATTERNS.some((pattern) => pattern.test(text));
}

export function findPreviousUserRequest(messages, {
  eventTs,
  userId,
  maxAgeSeconds = 60,
  excludedMessageTs = [],
} = {}) {
  const currentTs = Number(eventTs);
  const excluded = new Set(excludedMessageTs);
  return [...messages]
    .reverse()
    .find((message) => {
      const messageTs = Number(message.ts);
      const text = stripSlackMentions(message.text ?? '');
      return message.user === userId
        && !message.bot_id
        && !message.subtype
        && message.ts !== eventTs
        && !excluded.has(message.ts)
        && text.length > 0
        && Number.isFinite(currentTs)
        && Number.isFinite(messageTs)
        && currentTs >= messageTs
        && currentTs - messageTs <= maxAgeSeconds;
    });
}

export function stripSlackMentions(text = '') {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

// 요청 분기용 판별. 애매하면 false를 돌려 에이전트 작업으로 보낸다.
const TASK_INTENT = /(?:\bPR\b|풀리퀘|pull request|\bfix\b|수정|보정|고쳐|배포|머지|커밋|조회|대조|분석|원인|찾아|만들어|열어|올려|생성|삭제|추가|반영)/i;
const SERVICE_TARGET = /(?:서버|운영|\bprod\b|\bprd\b|\bdev\b|데브|개발|\bDB\b|디비|데이터|\bAPI\b|회원|멤버|그룹|챌린지|알림|기록|로그|앱)/i;

// '요약', 또는 thread·대화를 '정리'해 달라는 요청. 다른 작업이 섞이면 에이전트가 맡는다.
export function isThreadSummaryRequest(text = '') {
  const value = text.trim();
  const wantsSummary = /요약/.test(value)
    || (/(?:thread|쓰레드|스레드|대화|논의)/i.test(value) && /정리/.test(value));
  return wantsSummary && !TASK_INTENT.test(value);
}

// 봇 자체의 상태 질문. 서버·데이터 같은 대상이 붙으면 서비스 확인 요청으로 본다.
export function isHealthQuestion(text = '') {
  const value = text.trim();
  return /(?:살아.?있|살았|\bping\b|health|작동.?해|켜져.?있|상태)/i.test(value)
    && !SERVICE_TARGET.test(value)
    && !TASK_INTENT.test(value);
}

// 봇의 버전 차이 질문. '봇'이나 '이전 버전'을 직접 가리킬 때만 해당한다.
export function isVersionQuestion(text = '') {
  const value = text.trim();
  const aboutBot = /봇/.test(value) || /(?:이전|예전|기존)\s*버전/.test(value);
  return aboutBot
    && /(?:달라|차이|변경|바뀌|바뀐|개선|고도화|업데이트)/.test(value)
    && !SERVICE_TARGET.test(value)
    && !TASK_INTENT.test(value);
}

export function buildSafeChildEnvironment(source, additions = {}) {
  const blocked = /(?:TOKEN|SECRET|PASSWORD|PASSWD|WEBHOOK|PRIVATE_KEY|API_KEY|CREDENTIAL)/i;
  const allowed = [
    'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR',
    'TERM', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'GITHUB_CONFIG_DIR',
  ];
  const result = {};
  for (const key of allowed) {
    if (source[key] && !blocked.test(key)) {
      result[key] = source[key];
    }
  }
  return { ...result, ...additions };
}
