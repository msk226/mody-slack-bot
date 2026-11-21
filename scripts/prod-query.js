#!/usr/bin/env node
// 운영 DB 읽기 전용 조회 도구. 에이전트가 운영 데이터를 읽을 때 이 도구만 쓴다.
// 1) 한 문장 읽기 쿼리인지 검사하고 2) START TRANSACTION READ ONLY 안에서 실행한 뒤 항상 ROLLBACK한다.
// 개인정보·비밀값으로 보이는 컬럼 값은 ***로 가린다.
// 사용: node scripts/prod-query.js "SELECT id, nickname FROM member WHERE id = 1"

import { maskRows, prepareReadOnlyQuery } from '../src/prod-db/guard.js';
import { loadConfig, runSql } from '../src/prod-db/runner.js';

const rawSql = process.argv.slice(2).join(' ');

try {
  const sql = prepareReadOnlyQuery(rawSql);
  const { columns, rows } = await runSql(sql, loadConfig());
  const masked = maskRows(columns, rows);
  console.log(JSON.stringify({ columns, rows: masked, rowCount: masked.length }, null, 2));
} catch (error) {
  console.error(`조회하지 않았습니다: ${error.message}`);
  process.exit(1);
}
