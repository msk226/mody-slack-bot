import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareReadOnlyQuery, maskRows, quoteIdentifier } from '../src/prod-db/guard.js';
import { buildStdin, parseBatchOutput, loadConfig, buildRemoteCommand } from '../src/prod-db/runner.js';

test('SELECT without LIMIT gets the default limit', () => {
  assert.equal(prepareReadOnlyQuery('SELECT * FROM member'), 'SELECT * FROM member LIMIT 200');
});

test('existing LIMIT and trailing semicolon are kept as-is', () => {
  assert.equal(prepareReadOnlyQuery('select id from member limit 5;'), 'select id from member limit 5');
});

test('SHOW / EXPLAIN / WITH are allowed', () => {
  assert.equal(prepareReadOnlyQuery('SHOW TABLES'), 'SHOW TABLES');
  assert.ok(prepareReadOnlyQuery('EXPLAIN SELECT 1').startsWith('EXPLAIN'));
  assert.ok(prepareReadOnlyQuery('WITH t AS (SELECT 1 AS a) SELECT a FROM t').endsWith('LIMIT 200'));
});

test('write and DDL statements are rejected', () => {
  for (const sql of [
    'UPDATE member SET name = 1',
    'DELETE FROM member',
    'DROP TABLE member',
    'INSERT INTO member VALUES (1)',
    'SET GLOBAL read_only = 0',
  ]) {
    assert.throws(() => prepareReadOnlyQuery(sql), sql);
  }
});

test('stacked statements and hidden writes are rejected', () => {
  assert.throws(() => prepareReadOnlyQuery('SELECT 1; DELETE FROM member'));
  assert.throws(() => prepareReadOnlyQuery('SELECT * FROM member FOR UPDATE'));
  assert.throws(() => prepareReadOnlyQuery("SELECT * FROM member INTO OUTFILE '/tmp/x'"));
  assert.throws(() => prepareReadOnlyQuery('SELECT SLEEP(100)'));
  assert.throws(() => prepareReadOnlyQuery('/* x */ DELETE FROM member'));
});

test('keywords inside string literals do not trigger the deny list', () => {
  assert.ok(prepareReadOnlyQuery("SELECT * FROM record WHERE memo = 'drop; update'").startsWith('SELECT'));
});

test('sensitive columns are masked', () => {
  const rows = maskRows(['id', 'email', 'refresh_token', 'nickname'], [['1', 'a@b.c', 'tok', 'kim'], ['2', 'NULL', 'NULL', 'lee']]);
  assert.deepEqual(rows, [['1', '***', '***', 'kim'], ['2', 'NULL', 'NULL', 'lee']]);
});

test('MODY personal columns are masked', () => {
  const cols = ['provider_user_id', 'active_provider_identity_hash', 'birth_date', 'fcm_token', 'device_id', 'nickname'];
  assert.deepEqual(maskRows(cols, [['1', '2', '3', '4', '5', 'kim']]), [['***', '***', '***', '***', '***', 'kim']]);
});

test('identifiers are validated', () => {
  assert.equal(quoteIdentifier('member'), '`member`');
  assert.throws(() => quoteIdentifier('member`; DROP'));
});

test('stdin wraps the query in a read-only transaction and rolls back', () => {
  const stdin = buildStdin('SELECT 1', { maxExecutionMs: 10000 });
  assert.match(stdin, /START TRANSACTION READ ONLY;\nSELECT 1;\nROLLBACK;/);
  assert.match(stdin, /MAX_EXECUTION_TIME=10000/);
});

test('batch output is parsed into columns and rows', () => {
  assert.deepEqual(parseBatchOutput('id\tname\n1\tkim\n2\tlee\n'), { columns: ['id', 'name'], rows: [['1', 'kim'], ['2', 'lee']] });
});

test('config defaults to the mody-prod ssh alias and rejects shell metacharacters', () => {
  const config = loadConfig({});
  assert.equal(config.sshHost, 'mody-prod');
  assert.match(buildRemoteCommand(config), /^docker exec -i mody-mysql sh -c/);
  assert.throws(() => loadConfig({ MODY_DB_CONTAINER: 'x; rm -rf /' }));
});
