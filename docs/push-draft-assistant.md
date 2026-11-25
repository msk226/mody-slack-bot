# 푸시 공지 초안·사전 검증 어시스턴트 설계 (Phase 1)

## 1. 목적
비개발 팀원(PM·디자이너)이 슬랙에서 자연어로 푸시 공지 아이디어를 던지면, **LLM이 발송 초안을 구조화**하고 **결정론적 코드가 위험·충돌·피로도를 검증**해 리포트를 돌려주는 기능입니다.

> 현재 단계는 **설계와 핵심 검증 모듈**까지입니다. 실행 중인 봇에는 아직 연결하지 않았습니다.

## 2. 핵심 원칙 (3층 분리)
1. **LLM 계층** (`prompts/push-draft.md`, `config/push-draft.schema.json`)
   - 자연어 요청을 `title`, `content`, `targetType`(+`groupId`/`memberIds`), `scheduledAtKst`, `allowQuietHours`, `deepLink`, `assumptions`로 구조화하고 문구를 1차 점검합니다.
   - 모호한 조건(대상·시각 미명시)은 정하지 않고 `assumptions`와 `needsClarification`에 남깁니다.
2. **결정론적 가드레일 계층** (`src/push-guard.js`, `src/push-db-context.js`)
   - 안전 규칙은 LLM 판단에 맡기지 않고, 코드와 읽기 전용 운영 DB 조회(SELECT 전용 계정 + `START TRANSACTION READ ONLY` + `ROLLBACK`)로 판정합니다.
3. **사람 계층** (최종 승인·발송)
   - 봇은 FCM 발송 API를 부르지 않습니다. 슬랙에는 검증 리포트와 미리보기만 올립니다.
   - 최종 발송은 운영 콘솔의 관리자 세션에서 합니다.

## 3. 판정 기준은 "실제로 보낼 곳"에 맞춘다
검증이 PASS라고 했는데 콘솔이 거절하면 검증의 의미가 없습니다. 그래서 기준을 mody-server 공지 API(`AdminAnnouncementService`)와 서버 알림 코드에 맞췄습니다.

| 항목 | 1차안 | 서버 실제 | 지금 |
| --- | --- | --- | --- |
| 대상 | `ALL`, `ACTIVE_7D`, `ACTIVE_30D`, `SPECIFIC_MEMBERS` | `ALL`, `GROUP`, `MEMBERS`(최대 100명) | 서버와 같게. 활성 회원 대상은 콘솔에 없으므로 권고 문구도 바꿈 |
| 길이 한도 | 제목 100 / 본문 500 (DB 컬럼) | API가 제목 50 / 본문 200에서 거절 | API 한도로 차단, 25/60은 잠금화면 권장 |
| 수신 기기 수 | 모든 활성 토큰 (운영 257대) | `enabled = TRUE` 토큰에만 발송 | 서버와 같게 (운영 108대) |
| 리마인더 겹침 | `notification_setting.exercise_time` (값 있는 행 0개) | 운동 리마인더는 `exercise_schedule`(요일별, 982행) | 발송 요일의 `exercise_schedule` + 식사 시각 |
| 야간 | 무조건 차단 | `allowQuietHours=true`면 발송 | 명시하면 주의(WARN), 아니면 차단 |
| 발송 시각 | 시각이 없으면 야간 검사 생략 | 예약 발송 없음, 누르는 즉시 발송 | 시각이 없으면 지금 기준으로 판정 |
| 딥링크 | `/groups/123`, `/notifications`, `/settings` 허용 | 앱 경로는 `/groups/{id}/home`, `/records/meal` 등. 공지 API에는 딥링크 필드가 없음 | 서버가 만드는 경로만 허용하고, 적용되지 않는다고 주의 |
| 피로도 | 실패한 공지도 셈 | - | `send_status = FAILED` 제외 |
| 시각 해석 | 봇이 도는 컴퓨터의 시간대에 의존 | DB는 KST로 저장 | 오프셋 없는 값은 KST로 해석, DB 기준 시각도 KST 문자열로 전달 |
| 슬랙 출력 | 초안 문구를 그대로 mrkdwn에 넣음 | - | `& < >`를 바꿔 넣음 (`<!channel>` 등 전체 호출 방지) |

## 4. 결정론적 가드레일

| 규칙 | 판정 | 기준 |
| --- | --- | --- |
| 초안 형식 | `BLOCK` | 대상 종류, `GROUP`의 그룹 ID, `MEMBERS`의 회원 ID 1~100개, 시각 형식 |
| 길이 | `BLOCK` / `WARN` | 제목 50자·본문 200자 초과 → 차단 / 25자·60자 초과 → 잠금화면 주의 |
| 야간 | `BLOCK` / `WARN` | 발송 시각(없으면 지금)이 21:00~08:00 KST면 차단, 야간 발송 허용을 명시했으면 주의 |
| 리마인더·예정 공지 겹침 | `WARN` | 발송 요일의 리마인더 집중 시각(15명 이상) ±15분 → 30분 옮긴 시각 제안 |
| 피로도·중복 | `BLOCK` / `WARN` | 24시간 안 같은 제목+본문 → 차단 / 24시간 안 공지 1건 이상, 7일 안 2건 이상 → 주의 |
| 대상 모수 | `WARN` | `ALL`에서 최근 30일 미활동 비율 50% 이상 → 문구·대상 재검토 권고 |
| 딥링크 | `BLOCK` / `WARN` | 앱에 없는 경로·외부 URL → 차단 / 허용 경로 → 공지에 적용되지 않음 주의 |

## 5. Phase 2 확장 방향 (운영 콘솔 연동 시)
- `admin_announcement`에 예약 시각과 `DRAFT → APPROVED → SENT` 상태를 둡니다.
- 봇이 초안을 저장할 때의 신원은 신고 처리(mody-server LLD-0040)의 Slack 사용자 ↔ 관리자 계정 연결과 서명 방식을 재사용합니다. 요청한 사람이 초안 작성자로 남고, 별도 봇 서비스 계정을 두지 않습니다.
- 승인과 발송은 Google 로그인 관리자 세션에서만 허용하고 `admin_audit_log`에 남깁니다.
