// Runs SQL on the MySQL container through `ssh <host> docker exec`.
// The DB password is read from the container's own env inside the container and never leaves the server.

import { spawn } from 'node:child_process';

const SAFE_NAME = /^[A-Za-z0-9_.@-]+$/;

export function loadConfig(env = process.env) {
  const config = {
    sshHost: env.MODY_SSH_HOST || 'mody-prod', // ~/.ssh/config alias
    container: env.MODY_DB_CONTAINER || 'mody-mysql',
    timeoutMs: Number(env.MODY_QUERY_TIMEOUT_MS || 30000),
    maxExecutionMs: Number(env.MODY_MAX_EXECUTION_MS || 10000),
  };
  if (!SAFE_NAME.test(config.sshHost)) throw new Error('MODY_SSH_HOST 형식이 올바르지 않습니다.');
  if (!SAFE_NAME.test(config.container)) throw new Error('MODY_DB_CONTAINER 형식이 올바르지 않습니다.');
  return config;
}

export function buildRemoteCommand(config) {
  return `docker exec -i ${config.container} sh -c ` +
    `'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --batch --raw --default-character-set=utf8mb4 "$MYSQL_DATABASE"'`;
}

export function buildStdin(sql, config) {
  return [
    `SET SESSION MAX_EXECUTION_TIME=${Math.trunc(config.maxExecutionMs)};`,
    'START TRANSACTION READ ONLY;',
    `${sql};`,
    'ROLLBACK;',
    '',
  ].join('\n');
}

export function parseBatchOutput(stdout) {
  const lines = stdout.replace(/\n$/, '').split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };
  return { columns: lines[0].split('\t'), rows: lines.slice(1).map((l) => l.split('\t')) };
}

export function runSql(sql, config, { spawnImpl = spawn } = {}) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', config.sshHost, buildRemoteCommand(config)];
  return new Promise((resolve, reject) => {
    const child = spawnImpl('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`쿼리 시간이 ${config.timeoutMs}ms를 넘어 중단했습니다.`));
    }, config.timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const message = stderr.split('\n').filter((l) => !/Using a password/i.test(l)).join('\n').trim();
        reject(new Error(message || `원격 실행이 실패했습니다 (exit ${code}).`));
        return;
      }
      resolve(parseBatchOutput(stdout));
    });
    child.stdin.end(buildStdin(sql, config));
  });
}
