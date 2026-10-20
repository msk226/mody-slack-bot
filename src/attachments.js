// 에이전트가 요청별 폴더에 남긴 결과 파일을 Slack 스레드에 첨부한다.
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export async function createOutputDirectory(root, requestId) {
  const dir = path.join(root, requestId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

// 폴더 바로 아래의 일반 파일만 고른다. 링크·하위 폴더·빈 파일·너무 큰 파일은 건너뛴다.
export async function collectAttachments(dir, { maxFiles = MAX_ATTACHMENTS, maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
  const files = [];
  const skipped = [];
  let names;
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return { files, skipped };
  }
  for (const name of names) {
    const filePath = path.join(dir, name);
    const info = await lstat(filePath);
    if (!info.isFile() || info.size === 0) {
      continue;
    }
    if (info.size > maxBytes) {
      skipped.push(`${name} (용량 초과)`);
    } else if (files.length >= maxFiles) {
      skipped.push(`${name} (개수 초과)`);
    } else {
      files.push({ file: filePath, filename: name });
    }
  }
  return { files, skipped };
}

export async function uploadAttachments(client, { channel, threadTs, files }) {
  if (files.length === 0) {
    return;
  }
  await client.files.uploadV2({
    channel_id: channel,
    thread_ts: threadTs,
    file_uploads: files,
  });
}

export async function removeOutputDirectory(dir) {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
}
