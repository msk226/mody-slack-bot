# 푸시 공지 초안·사전 검증 어시스턴트 설계 (Phase 1)

## 1. 목적
비개발 팀원(PM·디자이너)이 슬랙에서 자연어로 푸시 공지 아이디어를 던지면, **LLM이 발송 초안을 구조화**하고 **결정론적 코드가 위험·충돌·피로도를 검증**해 리포트를 돌려주는 기능입니다.

> 현재 단계는 **설계 및 핵심 검증 모듈 개발**까지이며, 실행 중인 `mody-slack-bot` 데몬에는 아직 연결·가동하지 않았습니다.

## 2. 핵심 원칙 (3층 물리 분리)
1. **LLM 계층 (`prompts/push-draft.md`, `config/push-draft.schema.json`)**:
   - 자연어 요청을 `title`, `content`, `targetType`, `scheduledAtKst`, `deepLink`, `assumptions`로 구조화하고 문구 오류(오탈자·광고성 표현·앱 업데이트 안내 누락)를 1차 점검합니다.
   - 모호한 조건(대상·시각 미명시)은 임의로 확정하지 않고 `assumptions` 및 `needsClarification`에 남깁니다.
2. **결정론적 가드레일 계층 (`src/push-guard.js`, `src/push-db-context.js`)**:
   - 안전 규칙은 LLM 판단에 맡기지 않고 코드와 읽기 전용 운영 DB 조회(`START TRANSACTION READ ONLY` + `ROLLBACK`)로 판정합니다.
3. **사람 / ADMIN 계층 (최종 승인·발송)**:
   - 봇은 실제 FCM 발송 API를 절대 호출하지 않습니다.
   - Phase 1은 슬랙에 검증 리포트와 미리보기만 출력하며, Phase 2에서도 운영 콘솔 `DRAFT` 생성까지만 허용하고 최종 승인은 `ADMIN` 세션에서 수행합니다.

## 3. 결정론적 가드레일 5종

| 규칙 | 판정 | 기준 |
| --- | --- | --- |
| 야간 금지 시간대 | `BLOCK` | `21:00 ~ 08:00` KST 발송 차단 |
| DB 컬럼·화면 길이 | `BLOCK` / `WARN` | `title > 100` 또는 `content > 500` → `BLOCK` / 잠금화면 권장(`title > 25` 또는 `content > 60`) → `WARN` |
| 리마인더·예약 공지 충돌 | `WARN` | 기존 예약 공지 ±120분 이내 또는 리마인더 피크 시각 ±15분 이내 겹침 → 30분 이동 대안 시각 제안 |
| 피로도·중복 발송 | `BLOCK` / `WARN` | 24시간 내 동일 제목+본문 재요청 → `BLOCK` / 24시간 내 공지 이력 또는 7일 내 2회 이상 → `WARN` |
| 대상 모수·딥링크 | `BLOCK` / `WARN` | 허용되지 않은 딥링크/외부 URL → `BLOCK` / `ALL` 타겟에서 최근 30일 미활동 비율 50% 이상 → `WARN` |

## 4. Phase 2 확장 방향 (운영 콘솔 연동 시)
- `mody-server`의 `admin_announcement` 테이블에 `scheduled_at` 컬럼과 `DRAFT → APPROVED → SENT` 상태 추가
- 봇 전용 서비스 계정에는 `POST /admin/announcements/draft` 권한만 부여하고, `APPROVED`/`SEND`는 Google OAuth `ADMIN` 세션에서만 허용 (`admin_audit_log` 기록)
