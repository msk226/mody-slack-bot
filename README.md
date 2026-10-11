# MODY Slack Operations Agent

로컬 Mac에서 Slack 멘션을 작업 단위로 받아 MODY 코드, dev/prod 데이터, 서비스 상태를 확인하고 검증된 결과를 thread에 답변하는 운영 에이전트입니다.

## 구조

```text
Slack Socket Mode
  → 요청 접수·중복 방지
  → 영속 가능한 요청 ID·감사 기록
  → 동시성 제한 작업 큐
  → MODY 전용 Codex 에이전트
      → 요청 분해
      → 코드 / dev / prod / 작업 수행
      → 교차 검증
  → JSON Schema 결과 검증
  → Slack 결과 렌더링
```

단일 Mac 프로세스 규모에서는 외부 MQ, n8n, 벡터 DB를 사용하지 않는다. 작업 큐, 실행 계약, 감사 로그는 독립 모듈이므로 요청량이 늘면 외부 인프라로 교체할 수 있다.

## 실행

`.env` 파일은 이 디렉토리에 로컬로만 둡니다.

```bash
npm install
npm start
```

필수 환경변수:

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_ERROR_CHANNEL_ID=C... 또는 G...
GITHUB_REPO=Central-MakeUs/mody-server
MODY_REPO_PATH=/Users/minseokkim/Desktop/Code/mody-server
```

선택 환경변수:

```bash
AUTO_ANALYZE_ERRORS=true
USE_CODEX_ANALYSIS=true
CODEX_REASONING_EFFORT=high
# 0이면 timeout 없이 품질 우선으로 기다립니다.
CODEX_ANALYSIS_TIMEOUT_MS=0
# 비우면 gpt-5.6-luna를 사용합니다.
ENABLE_PRIVILEGED_OPERATIONS=true
AGENT_CONCURRENCY=1
AGENT_TIMEOUT_MS=1200000
PROCESS_EXISTING_MESSAGES=false
# Socket Mode 보조 폴링 간격입니다. 기본값은 60초이며, 0이면 비활성화합니다.
SLACK_POLL_INTERVAL_MS=60000
# Slack API polling that stays unavailable this long restarts the harness.
SLACK_WATCHDOG_MS=120000
```

## 사용법

- 에러 채널에 500 에러 메시지가 올라오면 자동으로 원인 후보를 thread에 답변합니다.
  - 답변은 `코드 수정 필요 가능성`, `데이터 보정 필요 가능성`, `운영 설정·외부 의존성 문제 가능성`을 근거와 함께 구분합니다.
  - 실제 DB를 직접 수정하지 않으며, 데이터 보정이 의심되면 대상 조건과 읽기 전용 확인 방향만 제시합니다.
- 봇을 멘션해서 코드 확인, dev/prod 데이터 조회, dev 보정, 코드 작업, PR, 배포 등을 요청할 수 있습니다.
- 하나의 요청에서 코드와 DB 상태를 함께 확인할 수 있습니다.
- 환경을 적지 않은 DB·서버 요청은 dev로 처리합니다. prod에 접근하려면 `운영`, `prod`, `prd` 중 하나를 명시합니다.
- 같은 thread에서 후속 질문을 하면 이전 사용자·봇 답변을 함께 읽고 새 댓글로 답합니다. 기존 답변은 수정하지 않으며, 질문마다 봇 멘션이 필요합니다.
- 결과는 `결론`, `확인 결과`, `판단`, `다음 조치`, `확인 ID`로 구성됩니다.
- 오래 걸리는 요청은 30초마다 같은 진행 댓글의 조사 단계와 경과 시간을 갱신합니다.

```text
@Mody Signal 온보딩 프로필 validation 어디서 걸려?
@Mody Signal AUTH401은 어디서 쓰여?
@Mody Signal 이 thread 요약해줘
@Mody Signal 운영에서 이 회원의 챌린지 달성 상태를 보고 코드 조건과도 대조해줘
```

```text
@Mody Signal fix 이 에러 PR까지 올려줘
```

모든 사용자는 구체적인 작업 지시를 바로 요청할 수 있습니다.

```text
@Mody Signal 이 thread 참고해서 PR 열어줘
@Mody Signal dev 테스트 그룹의 진행 중 챌린지 없는 데이터만 보정해줘
@Mody Signal dev 그룹 목록과 주간 챌린지 개수 확인해줘
@Mody Signal 5300022674432 memberId의 닉네임 조회해줘
@Mody Signal 운영 5300022674432 memberId의 닉네임 조회해줘
```


## 운영 기록

- 각 요청은 `MODY-YYYYMMDD-...` 형식의 확인 ID를 가집니다.
- 실행 상태, 환경, 소요 시간은 `logs/audit/operations.jsonl`에 기록됩니다.
- Slack 요청 본문과 비밀값은 감사 로그에 저장하지 않습니다.
- 실행 중인 작업과 대기 건수는 `상태 알려줘`로 확인할 수 있습니다.

## 접근 제어

- MODY 저장소 밖의 개인 로컬 파일·폴더 요청은 실행 전에 차단합니다.
- 봇을 멘션할 수 있는 모든 Slack 사용자가 dev·prod 조회, 데이터 변경, 코드 수정, GitHub 작업을 요청할 수 있습니다.
- Codex 자식 프로세스에는 Slack 토큰, API 키, 비밀번호 환경변수를 전달하지 않습니다.

## 검증

```bash
npm run check
npm test
```
