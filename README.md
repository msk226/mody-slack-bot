# MODY Slack 운영 봇

MODY 팀 Slack에서 동작하는 운영 봇입니다. 김민석의 Mac에서 실행됩니다. 에러 채널에 올라온 500 에러를 자동으로 분석하고, 봇을 멘션한 요청을 Codex 에이전트로 처리합니다.

## 하는 일

| 기능 | 동작 |
| --- | --- |
| 500 에러 분석 | 에러 채널 알림을 읽고 MODY 코드를 읽기 전용으로 분석해 thread에 원인 후보를 답합니다. 같은 에러의 GitHub 이슈를 만들거나, 열린 이슈가 있으면 연결합니다. |
| 멘션 작업 | 코드 확인, dev/prod 데이터 조회, dev 데이터 보정, 코드 수정·PR·배포 요청을 처리합니다. |
| thread 요약 | thread 대화를 요약합니다. |
| 봇 상태 | 실행 상태와 작업 큐를 바로 답합니다. |
| 일일 리포트 | 매일 09:00(KST)에 MODY 저장소의 `daily-report.yml` 워크플로를 실행합니다. |

## 동작 구조

```text
Slack (Socket Mode + 에러 채널 60초 보조 폴링)
├─ 에러 채널 500 알림
│   → 파싱 → 스캐너 요청 제외 → 중복 확인
│   → Codex 읽기 전용 분석 → thread 답변 → GitHub 이슈 생성·연결
└─ 봇 멘션
    → 민감 정보·개인 파일 요청 거절
    → 요약·상태·버전 질문은 바로 처리
    → 그 외: 작업 큐(동시 1건) → Codex 전체 권한 실행
      → 결과 JSON 검증 → thread 답변, 감사 기록

매일 09:00 KST → gh workflow run daily-report.yml
```

## 실행 환경

| 항목 | 내용 |
| --- | --- |
| 실행 | `screen` 세션 `mody-slack-bot`에서 `scripts/run-forever.sh`를 실행합니다. |
| 재시작 | `run-forever.sh`가 봇이 종료되면 5초 뒤 다시 띄웁니다. 이때 `.env`를 다시 읽습니다. |
| 잠자기 방지 | launchd `com.mody.keepawake`(`caffeinate -imsu`)가 Mac이 잠들지 않게 합니다. |
| 자동 시작 | launchd `com.mody.slack-error-harness`는 등록돼 있지만 비활성화 상태입니다. 재부팅 후에는 직접 시작해야 합니다. |
| AI | Codex CLI(`codex exec`)를 씁니다. ChatGPT 계정으로 로그인하고, 기본 모델은 `gpt-6-luna`입니다. |
| GitHub | `gh` CLI로 이슈를 만들고 워크플로를 실행합니다. |
| MODY 코드 | Codex는 `~/Desktop/Code/mody-server`에서 작업합니다. |
| 서버 접근 | SSH 별칭 `mody-dev`·`mody-prod`와 Codex 스킬 `mody-operations`(조회)·`mody-dev-operations`(dev 변경)를 씁니다. |
| Node.js | 현재 v25.5.0에서 실행 중입니다. |

## 운영 명령

모든 명령은 이 폴더(`~/Desktop/Code/mody-slack-bot`)에서 실행합니다.

```bash
# 시작 (재부팅 후 등)
screen -dmS mody-slack-bot /bin/zsh -lc 'cd ~/Desktop/Code/mody-slack-bot && exec bash scripts/run-forever.sh'

# 실행 확인
screen -ls
tail -f logs/slack-error-harness.log

# 코드나 .env 변경 반영: 봇 프로세스만 끄면 감시 스크립트가 5초 뒤 새로 띄웁니다
pkill -P "$(pgrep -P "$(cat logs/slack-error-harness.pid)")" -f "node src/index.js"

# 완전히 중지
screen -S mody-slack-bot -X quit
```

Slack에서 `@Mody Signal 상태 알려줘`로 실행 중인 작업과 대기 작업 수를 볼 수 있습니다.

## 설정 (`.env`)

`.env`는 이 폴더에만 두고 커밋하지 않습니다.

필수:

| 변수 | 설명 |
| --- | --- |
| `SLACK_BOT_TOKEN` | 봇 토큰 (`xoxb-`) |
| `SLACK_APP_TOKEN` | Socket Mode 앱 토큰 (`xapp-`) |
| `SLACK_ERROR_CHANNEL_ID` | 500 에러 알림이 올라오는 채널 ID |

선택 (괄호 안은 기본값):

| 변수 | 설명 |
| --- | --- |
| `MODY_REPO_PATH` | MODY 서버 코드 경로 (`/Users/minseokkim/Desktop/Code/mody-server`) |
| `GITHUB_REPO` | 이슈·리포트 대상 저장소 (`Central-MakeUs/mody-server`) |
| `AUTO_ANALYZE_ERRORS` | 500 에러 자동 분석 (`true`) |
| `AUTO_CREATE_ISSUES` | 에러별 GitHub 이슈 생성 (`true`) |
| `GITHUB_ISSUE_LABELS` | 이슈 라벨, 쉼표로 구분 (`bug`) |
| `GH_PATH` | gh 실행 파일 경로 (`/opt/homebrew/bin/gh`) |
| `DAILY_REPORT_TRIGGER_ENABLED` | 일일 리포트 실행 (`true`) |
| `DAILY_REPORT_TIME` | 일일 리포트 시각, KST (`09:00`) |
| `USE_CODEX_ANALYSIS` | 에러 분석에 Codex 사용. `false`면 키워드 코드 검색만 합니다 (`true`) |
| `CODEX_ANALYSIS_MODEL` | Codex 모델 (`gpt-6-luna`) |
| `CODEX_REASONING_EFFORT` | Codex 추론 강도 (`medium`) |
| `CODEX_ANALYSIS_TIMEOUT_MS` | 에러 분석·요약 제한 시간. 0은 무제한 (`0`) |
| `AGENT_TIMEOUT_MS` | 멘션 작업 제한 시간 (`1200000`, 20분) |
| `AGENT_CONCURRENCY` | 동시에 처리할 멘션 작업 수 (`1`) |
| `SLACK_POLL_INTERVAL_MS` | 에러 채널 보조 폴링 간격. 0은 끕니다 (`60000`) |
| `SLACK_WATCHDOG_MS` | 폴링이 이 시간 넘게 실패하면 프로세스를 재시작합니다 (`120000`) |
| `PROCESS_EXISTING_MESSAGES` | 봇 시작 전 메시지도 처리 (`false`) |
| `SLACK_BOT_USER_ID`, `SLACK_BOT_ID` | 비우면 시작할 때 Slack에서 조회합니다 |
| `ENABLE_PRIVILEGED_OPERATIONS` | 현재 사용하는 코드가 없습니다. 멘션 작업은 의도적으로 값과 관계없이 전체 권한으로 실행됩니다 (`true`) |

파일 위치는 `AGENT_PROMPT_PATH`, `AGENT_RESULT_SCHEMA_PATH`, `ERROR_ISSUE_CACHE_FILE`, `DAILY_REPORT_STATE_FILE`, `HANDLED_ALERT_DIRECTORY`, `AUDIT_DIRECTORY`로 바꿀 수 있습니다. 기본값은 `prompts/`, `config/`, `logs/` 아래입니다.

## Slack 사용법

### 500 에러 자동 분석

- 에러 채널에 서버 에러 알림이 올라오면 thread에 원인 후보를 답합니다. 대응은 `데이터 확인/보정`, `기능 수정`, `외부 서비스 확인`, `추가 확인 필요`로 나눕니다.
- 같은 에러(메서드·경로·예외·첫 스택 프레임)는 30분 안에 한 번만 분석합니다.
- `/.env`, `/wp-admin` 같은 스캐너 요청과 `MultipartException`은 무시합니다.
- 같은 에러로 열린 GitHub 이슈가 있으면 새로 만들지 않고 링크만 답니다.

### 멘션 요청

```text
@Mody Signal 온보딩 프로필 validation 어디서 걸려?
@Mody Signal dev 그룹 목록과 주간 챌린지 개수 확인해줘
@Mody Signal 운영에서 이 회원의 챌린지 달성 여부를 코드 조건과 대조해줘
@Mody Signal fix 이 에러 PR까지 올려줘
@Mody Signal 이 thread 요약해줘
```

- 환경을 적지 않은 데이터·서버 요청은 dev로 처리합니다. prod는 `운영`, `prod`, `prd` 중 하나를 적어야 접근합니다.
- 같은 thread의 이전 대화를 읽고 이어서 답합니다. 질문할 때마다 봇을 멘션해야 합니다.
- 멘션만 남기면 60초 안에 쓴 직전 메시지를 요청으로 씁니다. 그런 메시지가 없으면 10초 동안 이어지는 메시지를 기다립니다.
- 오래 걸리는 작업은 30초마다 진행 댓글을 갱신합니다.
- 요청 메시지에 리액션으로 상태를 표시합니다: `확인중` → `loading` → `완료` 또는 `alert-red`.
- 결과는 `처리 결과`, `확인 결과`, `판단`, `다음 조치`, `참고`, `확인 ID` 순서로 답합니다.

### 요청 분기 순서

봇은 요청에 들어간 말로 처리 방식을 정하고, 위에서부터 먼저 맞는 규칙을 따릅니다.

| 요청 | 처리 |
| --- | --- |
| `.env`·토큰·비밀값을 읽거나 보여 달라는 요청 | 거절 |
| `Desktop`, `~/`, `.ssh` 같은 개인 파일·폴더 | 거절 |
| `요약`, 또는 thread·대화를 `정리`해 달라는 요청 | thread 요약 (읽기 전용) |
| 대상 없이 `상태`, `살아있`, `ping`, `작동해`를 묻는 질문 | 봇 상태 답변 |
| `봇`이나 `이전 버전`에서 무엇이 달라졌는지 묻는 질문 | 버전 차이 답변 |
| 그 외 | 에이전트 작업 (전체 권한) |

요약·상태·버전 질문이어도 서버, 운영, dev, 데이터, 회원, 챌린지, 알림 같은 대상이나 PR, 수정, 조회, 분석 같은 작업이 함께 있으면 에이전트 작업으로 처리합니다. 예를 들어 "운영 서버 상태 확인해줘"는 서버 상태를 확인하고, "이 thread 참고해서 PR 열어줘"는 PR을 엽니다. 판별 규칙과 테스트는 `src/request-policy.js`, `test/request-policy.test.js`에 있습니다.

민감 정보·개인 파일 차단은 안전을 위해 넓게 잡혀 있어서 `키워드`, `Library` 같은 말이 들어간 요청도 거절될 수 있습니다.

## 권한과 안전장치

- 에러 분석과 thread 요약은 Codex 읽기 전용 샌드박스에서 실행합니다.
- 그 외 멘션 작업은 의도적으로 Codex를 샌드박스와 승인 없이 전체 권한으로 실행합니다. 작업 범위는 `prompts/mody-agent.md`의 지침으로 제한하고, 코드로 강제하지는 않습니다. 봇을 멘션할 수 있는 모든 Slack 사용자가 요청할 수 있습니다.
- Codex에는 허용한 환경변수(`HOME`, `PATH`, `SSH_AUTH_SOCK` 등)만 넘깁니다. 이름에 `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY` 같은 단어가 들어간 변수는 넘기지 않습니다.
- 감사 기록(`logs/audit/operations.jsonl`)에는 확인 ID, 상태, 환경, 채널, 사용자, 소요 시간만 남깁니다. 요청 본문과 비밀값은 남기지 않습니다.

## 로그와 상태 파일

`logs/`는 git에서 제외합니다.

| 파일 | 내용 |
| --- | --- |
| `slack-error-harness.log` | 실행 로그 |
| `audit/operations.jsonl` | 요청별 감사 기록 |
| `handled-alerts/` | 처리한 에러 알림 표시 (중복 처리 방지) |
| `error-issues.json` | 에러별 GitHub 이슈 캐시 |
| `daily-report-trigger.json` | 일일 리포트 마지막 실행일 |
| `slack-error-harness.pid`, `slack-error-harness.lock/` | 감시 스크립트 PID와 중복 실행 방지 |

## 파일 구조

```text
src/
  index.js                 Slack 이벤트 처리, 요청 분기, Codex 실행
  agent-contract.js        환경 추론, 결과 JSON 파싱, Slack 답변 형식
  request-policy.js        개인 파일 요청 판별, Codex에 넘길 환경변수 필터
  job-queue.js             동시 실행 수를 제한하는 작업 큐
  slack-status.js          상태 리액션, 알림 환경 판별
  github-issue.js          에러별 GitHub 이슈 생성·재사용
  daily-report-trigger.js  일일 리포트 워크플로 실행
  audit-log.js             감사 기록
prompts/mody-agent.md      멘션 작업 에이전트 지침
config/agent-result.schema.json  에이전트 결과 JSON 스키마
scripts/run-forever.sh     감시·재시작 스크립트
test/                      단위 테스트
```

## 개발

```bash
npm install
npm run check   # 문법 검사
npm test        # 단위 테스트
```

변경은 커밋으로 관리하고 `.bak` 사본을 만들지 않습니다. 에이전트 작업 규칙은 `AGENTS.md`에 있습니다.

## 문제 해결

| 증상 | 확인 |
| --- | --- |
| 봇이 답하지 않음 | `screen -ls`로 세션을 확인합니다. 없으면 시작 명령을 실행하고 `logs/slack-error-harness.log` 마지막 줄을 봅니다. |
| 로그에 `ENOTFOUND slack.com` | 네트워크가 끊긴 경우입니다. 감시 스크립트가 자동으로 다시 띄웁니다. |
| 로그에 `Codex ... failed` | `codex login status`로 ChatGPT 로그인을 확인합니다. Codex가 실패하면 에러 분석은 키워드 검색 결과로 대신 답합니다. |
| GitHub 이슈·리포트가 안 됨 | `gh auth status`를 확인합니다. |
