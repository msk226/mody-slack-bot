import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProdAccessInstructions,
  decideProdAccess,
  isDataChangeRequest,
  parseOwnerIds,
} from '../src/prod-access.js';

const owners = parseOwnerIds(' U_OWNER , ,U_OTHER_OWNER');

test('parses owner ids from a comma list', () => {
  assert.deepEqual([...owners], ['U_OWNER', 'U_OTHER_OWNER']);
  assert.equal(parseOwnerIds('').size, 0);
});

test('requests without prod stay on the default (dev) path', () => {
  assert.deepEqual(decideProdAccess({ environment: 'none', text: '회원 기록 삭제해줘', userId: 'U_MEMBER', ownerIds: owners }), { mode: 'default' });
  assert.deepEqual(decideProdAccess({ environment: 'dev', text: 'dev 챌린지 데이터 넣어줘', userId: 'U_MEMBER', ownerIds: owners }), { mode: 'default' });
});

test('anyone can read prod', () => {
  assert.deepEqual(decideProdAccess({ environment: 'prod', text: '운영에서 이 회원 챌린지 달성 여부 확인해줘', userId: 'U_MEMBER', ownerIds: owners }), { mode: 'prod_read' });
});

test('team members cannot change prod data', () => {
  assert.deepEqual(
    decideProdAccess({ environment: 'prod', text: '운영 DB에서 이 회원 걸음수 보정해줘', userId: 'U_MEMBER', ownerIds: owners, prodWritesEnabled: true }),
    { mode: 'deny', reason: 'not_owner' },
  );
  assert.deepEqual(
    decideProdAccess({ environment: 'mixed', text: 'dev랑 운영 둘 다 기록 삭제해줘', userId: 'U_MEMBER', ownerIds: owners, prodWritesEnabled: true }),
    { mode: 'deny', reason: 'not_owner' },
  );
});

test('requests without a user id are treated as non-owners', () => {
  assert.equal(decideProdAccess({ environment: 'prod', text: '운영 회원 닉네임 수정해줘', userId: undefined, ownerIds: owners, prodWritesEnabled: true }).mode, 'deny');
});

test('owners can change prod only when prod writes are enabled', () => {
  assert.deepEqual(
    decideProdAccess({ environment: 'prod', text: '운영 회원 닉네임 수정해줘', userId: 'U_OWNER', ownerIds: owners }),
    { mode: 'deny', reason: 'prod_writes_disabled' },
  );
  assert.deepEqual(
    decideProdAccess({ environment: 'prod', text: '운영 회원 닉네임 수정해줘', userId: 'U_OWNER', ownerIds: owners, prodWritesEnabled: true }),
    { mode: 'prod_write' },
  );
});

test('detects data change requests', () => {
  assert.equal(isDataChangeRequest('운영 DB에서 기록 삭제해줘'), true);
  assert.equal(isDataChangeRequest('운영 그룹 이름 바꿔줘'), true);
  assert.equal(isDataChangeRequest('운영 회원 수 알려줘'), false);
  assert.equal(isDataChangeRequest('운영 서버 상태 확인해줘'), false);
});

test('prod read instructions point the agent at the read-only query tool', () => {
  const lines = buildProdAccessInstructions('prod_read', { queryCommand: 'node /bot/scripts/prod-query.js' }).join('\n');
  assert.match(lines, /조회 전용/);
  assert.match(lines, /node \/bot\/scripts\/prod-query\.js/);
  assert.match(lines, /READ ONLY/);
  assert.deepEqual(buildProdAccessInstructions('default', { queryCommand: 'x' }), []);
});
