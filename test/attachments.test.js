import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectAttachments, createOutputDirectory, removeOutputDirectory } from '../src/attachments.js';

test('collects only regular files within the limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mody-attach-'));
  const dir = await createOutputDirectory(root, 'MODY-20261020-0001');
  await writeFile(path.join(dir, 'a.csv'), 'sub\n1\n');
  await writeFile(path.join(dir, 'b.txt'), 'x');
  await writeFile(path.join(dir, 'big.csv'), 'x'.repeat(20));
  await writeFile(path.join(dir, 'empty.txt'), '');
  await mkdir(path.join(dir, 'nested'));
  await symlink('/etc/hosts', path.join(dir, 'link.txt'));

  const { files, skipped } = await collectAttachments(dir, { maxFiles: 1, maxBytes: 10 });
  assert.deepEqual(files.map((item) => item.filename), ['a.csv']);
  assert.deepEqual(skipped, ['b.txt (개수 초과)', 'big.csv (용량 초과)']);

  await removeOutputDirectory(dir);
  assert.deepEqual(await readdir(root), []);
});

test('returns nothing when the directory is missing', async () => {
  assert.deepEqual(await collectAttachments('/nonexistent/mody'), { files: [], skipped: [] });
});
