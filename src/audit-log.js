import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class AuditLog {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'operations.jsonl');
  }

  async record(event) {
    await mkdir(this.directory, { recursive: true });
    const safeEvent = {
      timestamp: new Date().toISOString(),
      requestId: event.requestId,
      type: event.type,
      status: event.status,
      environment: event.environment,
      slackChannel: event.slackChannel,
      slackUser: event.slackUser,
      durationMs: event.durationMs,
      errorCode: event.errorCode,
    };
    await appendFile(this.file, `${JSON.stringify(safeEvent)}\n`, { mode: 0o600 });
  }
}
