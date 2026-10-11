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

export function buildSafeChildEnvironment(source, additions = {}) {
  const blocked = /(?:TOKEN|SECRET|PASSWORD|PASSWD|WEBHOOK|PRIVATE_KEY|API_KEY|CREDENTIAL)/i;
  const allowed = [
    'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR',
    'TERM', 'SSH_AUTH_SOCK', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'GITHUB_CONFIG_DIR',
  ];
  const result = {};
  for (const key of allowed) {
    if (source[key] && !blocked.test(key)) {
      result[key] = source[key];
    }
  }
  return { ...result, ...additions };
}
