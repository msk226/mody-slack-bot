import { EventEmitter } from 'node:events';

export class JobQueue extends EventEmitter {
  #concurrency;
  #active = 0;
  #pending = [];

  constructor({ concurrency = 1 } = {}) {
    super();
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('concurrency must be a positive integer');
    }
    this.#concurrency = concurrency;
  }

  get activeCount() {
    return this.#active;
  }

  get pendingCount() {
    return this.#pending.length;
  }

  enqueue(id, task) {
    if (!id || typeof task !== 'function') {
      throw new Error('enqueue requires an id and task');
    }

    const position = this.#pending.length + Math.max(0, this.#active - this.#concurrency + 1);
    const promise = new Promise((resolve, reject) => {
      this.#pending.push({ id, task, resolve, reject });
      this.emit('queued', { id, position, pending: this.pendingCount, active: this.activeCount });
      this.#drain();
    });

    return { position, promise };
  }

  #drain() {
    while (this.#active < this.#concurrency && this.#pending.length > 0) {
      const job = this.#pending.shift();
      this.#active += 1;
      this.emit('started', { id: job.id, pending: this.pendingCount, active: this.activeCount });

      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.#active -= 1;
          this.emit('finished', { id: job.id, pending: this.pendingCount, active: this.activeCount });
          this.#drain();
        });
    }
  }
}
