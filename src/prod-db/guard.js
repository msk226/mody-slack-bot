// SQL guard: only single read-only statements reach the database.
// The database call also runs inside START TRANSACTION READ ONLY, so this is the first of two layers.

const ALLOWED_FIRST_KEYWORDS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']);

const FORBIDDEN = [
  /\b(INSERT|UPDATE|DELETE|REPLACE|MERGE|UPSERT)\b/i,
  /\b(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b/i,
  /\b(GRANT|REVOKE|SET|LOCK|UNLOCK|CALL|HANDLER|LOAD|DO|KILL|SHUTDOWN|FLUSH|RESET|PURGE)\b/i,
  /\bINTO\s+(OUTFILE|DUMPFILE|@)/i,
  /\bFOR\s+(UPDATE|SHARE)\b/i,
  /\bLOCK\s+IN\s+SHARE\s+MODE\b/i,
  /\b(SLEEP|BENCHMARK|GET_LOCK|LOAD_FILE)\s*\(/i,
];

export const DEFAULT_ROW_LIMIT = 200;
export const MAX_ROW_LIMIT = 1000;

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(--|#)[^\n]*/g, ' ');
}

function stripStringLiterals(sql) {
  // Keywords inside quoted values (e.g. WHERE title = 'drop') must not trigger the deny list.
  return sql.replace(/'(?:[^'\\]|\\.|'')*'/g, "''").replace(/"(?:[^"\\]|\\.|"")*"/g, '""');
}

/**
 * Validates a query and returns the SQL to run (with a LIMIT added when needed).
 * Throws an Error with a user-facing message when the query is not allowed.
 */
export function prepareReadOnlyQuery(rawSql, { limit = DEFAULT_ROW_LIMIT } = {}) {
  if (typeof rawSql !== 'string' || rawSql.trim() === '') {
    throw new Error('빈 쿼리입니다.');
  }
  const rowLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_ROW_LIMIT);

  let sql = stripComments(rawSql).trim().replace(/;\s*$/, '').trim();
  const inspected = stripStringLiterals(sql);

  if (inspected.includes(';')) {
    throw new Error('한 번에 하나의 문장만 실행할 수 있습니다.');
  }

  const firstKeyword = inspected.split(/\s+/)[0].toUpperCase();
  if (!ALLOWED_FIRST_KEYWORDS.has(firstKeyword)) {
    throw new Error(`읽기 전용 쿼리만 허용합니다 (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN). 받은 문장: ${firstKeyword}`);
  }

  for (const pattern of FORBIDDEN) {
    if (pattern.test(inspected)) {
      throw new Error(`허용하지 않는 구문이 있습니다: ${pattern.source}`);
    }
  }

  if ((firstKeyword === 'SELECT' || firstKeyword === 'WITH') && !/\bLIMIT\s+\d+/i.test(inspected)) {
    sql = `${sql} LIMIT ${rowLimit}`;
  }
  return sql;
}

const SENSITIVE_COLUMN = /(password|passwd|secret|token|refresh|access_key|api_key|credential|email|phone|mobile|social_id|provider_id|provider_user|identity|device_id|fcm|apns|ip_address|birth)/i;

/** Masks values of columns whose names look like personal data or credentials. */
export function maskRows(columns, rows) {
  const masked = columns.map((c) => SENSITIVE_COLUMN.test(c));
  if (!masked.some(Boolean)) return rows;
  return rows.map((row) => row.map((value, i) => (masked[i] && value !== 'NULL' ? '***' : value)));
}

export function isSensitiveColumn(name) {
  return SENSITIVE_COLUMN.test(name);
}

export function quoteIdentifier(name) {
  if (!/^[A-Za-z0-9_$]+$/.test(name)) {
    throw new Error(`잘못된 테이블 이름입니다: ${name}`);
  }
  return `\`${name}\``;
}
