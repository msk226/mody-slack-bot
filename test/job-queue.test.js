import test from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../src/job-queue.js';

test('runs jobs sequentially by default', async () => {
  const queue = new JobQueue();
  const order = [];
  const first = queue.enqueue('first', async () => {
    order.push('first:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('first:end');
  });
  const second = queue.enqueue('second', async () => {
    order.push('second:start');
    order.push('second:end');
  });

  await Promise.all([first.promise, second.promise]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('continues after a failed job', async () => {
  const queue = new JobQueue();
  const failed = queue.enqueue('failed', async () => {
    throw new Error('boom');
  });
  const next = queue.enqueue('next', async () => 'ok');

  await assert.rejects(failed.promise, /boom/);
  assert.equal(await next.promise, 'ok');
});
