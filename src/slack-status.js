export const STATUS_EMOJI = {
  received: '확인중',
  running: 'loading',
  completed: '완료',
  failed: 'alert-red',
};

const currentReactions = new Map();

export function alertEnvironment(text = '') {
  const value = text.match(/\*?Environment\*?\s*:\s*`?([^`\n]+)/i)?.[1]?.trim().toLowerCase();
  if (['prod', 'prd', 'production'].includes(value)) return 'prod';
  if (['dev', 'development'].includes(value)) return 'dev';
  return null;
}

export function stripStatusEmoji(text = '') {
  return text.normalize('NFC').replace(/^:(?:loading|확인중|완료|alert-red):\s*/, '');
}

export function formatStatusEmoji(text) {
  return text.replace(/:(확인중|완료|운영|개발):/g, (_, name) => `:${name.normalize('NFD')}:`);
}

// Status is shown through reactions; message bodies stay text-only.
export function slackMessage(text) {
  const plain = text.normalize('NFC')
    .replace(/:(?:loading|확인중|완료|alert-red|운영|개발|red_circle|large_blue_circle):[ \t]*/g, '')
    .trim();
  return { text: plain, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: plain } }] };
}

// Slack may retain decomposed Hangul names uploaded from macOS/iOS.
export function emojiNames(name) {
  return [...new Set([name, name.normalize('NFD'), name.normalize('NFC')])];
}

export async function addReaction(client, event, name, fallback) {
  for (const candidate of [...emojiNames(name), ...(fallback ? [fallback] : [])]) {
    try {
      await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: candidate });
      return candidate;
    } catch (error) {
      const code = error?.data?.error;
      if (code === 'already_reacted') return candidate;
      if (code === 'invalid_name') continue;
      console.error('Failed to add status reaction:', code ?? error.message);
      return null;
    }
  }
  return null;
}

export async function setStatusReaction(client, event, status) {
  const key = `${event.channel}:${event.ts}`;
  const previous = currentReactions.get(key);
  if (previous) {
    try {
      await client.reactions.remove({ channel: event.channel, timestamp: event.ts, name: previous });
    } catch (error) {
      if (!['no_reaction', 'invalid_name'].includes(error?.data?.error)) {
        console.error('Failed to remove status reaction:', error?.data?.error ?? error.message);
      }
    }
  }
  const fallback = { received: 'eyes', running: 'hourglass_flowing_sand', completed: 'white_check_mark', failed: 'warning' };
  const added = await addReaction(client, event, STATUS_EMOJI[status], fallback[status]);
  if (status === 'completed' || status === 'failed') currentReactions.delete(key);
  else if (added) currentReactions.set(key, added);
  if (currentReactions.size > 1000) currentReactions.delete(currentReactions.keys().next().value);
  return added;
}

export async function markAlertEnvironment(client, event) {
  const environment = alertEnvironment(event.text);
  if (environment) {
    await addReaction(client, event, environment === 'prod' ? '운영' : '개발');
  }
}
