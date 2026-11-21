// 운영(prod) 접근을 요청자에 따라 나눈다.
// - 환경을 적지 않은 요청은 dev로 간다 (기본값).
// - 운영 조회는 누구나 할 수 있지만, 운영 DB는 READ ONLY 트랜잭션 조회 도구로만 읽는다.
// - 운영 데이터 변경은 서버 담당자만 요청할 수 있고, ENABLE_PROD_WRITES=true일 때만 열린다.

const DATA_TARGET = /(?:데이터|\bDB\b|디비|데이터베이스|테이블|회원|멤버|그룹|챌린지|기록|걸음\s*수|걸음수|알림|닉네임|체중|신고|컬럼|row|행)/i;
const CHANGE_VERB = /(?:보정|수정|삭제|지워|생성|추가|넣어|업데이트|반영|변경|바꿔|초기화|복구|롤백|insert|update|delete)/i;

export function parseOwnerIds(value = '') {
  return new Set(String(value).split(',').map((id) => id.trim()).filter(Boolean));
}

export function isProdEnvironment(environment) {
  return environment === 'prod' || environment === 'mixed';
}

// 데이터 대상과 변경 동사가 함께 있으면 데이터 변경 요청으로 본다. 애매하면 변경으로 본다(더 엄격한 쪽).
export function isDataChangeRequest(text = '') {
  return DATA_TARGET.test(text) && CHANGE_VERB.test(text);
}

/**
 * @returns {{ mode: 'default' | 'prod_read' | 'prod_write' | 'deny', reason?: string }}
 */
export function decideProdAccess({ environment, text, userId, ownerIds = new Set(), prodWritesEnabled = false }) {
  if (!isProdEnvironment(environment)) {
    return { mode: 'default' };
  }
  if (!isDataChangeRequest(text)) {
    return { mode: 'prod_read' };
  }
  if (!userId || !ownerIds.has(userId)) {
    return { mode: 'deny', reason: 'not_owner' };
  }
  if (!prodWritesEnabled) {
    return { mode: 'deny', reason: 'prod_writes_disabled' };
  }
  return { mode: 'prod_write' };
}

export function renderProdDenyReply(reason, requestId) {
  const body = reason === 'not_owner'
    ? [
        ':no_entry: *운영 데이터 변경은 서버 담당자만 요청할 수 있습니다.*',
        '운영 데이터 조회는 지금처럼 요청하시면 됩니다.',
        '개발 서버 데이터 보정이라면 `운영` 없이 다시 요청해 주세요. 운영 데이터 변경이 꼭 필요하면 서버 담당자에게 알려 주세요.',
      ]
    : [
        ':no_entry: *운영 데이터 변경이 지금 꺼져 있습니다.*',
        '서버 담당자가 직접 처리하거나, 설정에서 운영 변경을 켠 뒤 다시 요청해 주세요.',
      ];
  return [...body, '', `_확인 ID: ${requestId}_`].join('\n');
}

export function buildProdAccessInstructions(mode, { queryCommand }) {
  if (mode === 'prod_read') {
    return [
      '- 운영 권한: 조회 전용 (요청자는 운영 데이터를 바꿀 수 없다)',
      `- 운영 DB 조회는 반드시 \`${queryCommand} "<SQL 한 문장>"\`으로만 한다. 이 도구는 SELECT·WITH·SHOW·DESCRIBE·EXPLAIN 한 문장만 받고, READ ONLY 트랜잭션 안에서 실행한 뒤 항상 ROLLBACK한다.`,
      '- 운영에서 mysql을 직접 실행하지 않는다. 운영 데이터 변경, 서비스 재시작, 배포는 하지 않는다.',
    ];
  }
  if (mode === 'prod_write') {
    return [
      '- 운영 권한: 서버 담당자 요청이라 운영 데이터 변경을 허용한다.',
      `- 조회는 \`${queryCommand} "<SQL 한 문장>"\`으로 한다.`,
      '- 변경 전 같은 조건으로 대상 수를 조회하고, 최소 범위로 바꾼 뒤 같은 조건으로 결과를 검증한다. 대상이 예상과 다르면 바꾸지 않고 needs_input으로 묻는다.',
      '- 서비스 재시작과 배포는 하지 않는다.',
    ];
  }
  return [];
}
