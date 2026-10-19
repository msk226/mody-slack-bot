# MODY Slack 운영 봇

MODY 팀 Slack에서 동작하는 운영 봇입니다. 김민석의 Mac에서 실행됩니다. 에러 채널에 올라온 500 에러를 자동으로 분석하고, 봇을 멘션한 요청을 Antigravity CLI(`agy`) 에이전트로 처리합니다.

AI 에이전트가 팀 서버에 접근하는 만큼, 무엇을 어디까지 할 수 있는지 먼저 정했습니다. 자세한 내용은 [권한과 안전장치](#권한과-안전장치)에 있습니다.

## 하는 일

| 기능 | 동작 |
| --- | --- |
| 500 에러 분석 | 에러 채널 알림을 읽고 MODY 코드를 읽기 전용으로 분석해 thread에 원인 후보를 답합니다. 같은 에러의 GitHub 이슈를 만들거나, 열린 이슈가 있으면 연결합니다. |
| 멘션 작업 | 코드 확인, dev/prod 데이터 조회, dev 데이터 보정, 코드 수정·PR·배포 요청을 처리합니다. |
| thread 요약 | thread 대화를 요약합니다. |
| 봇 상태 | 실행 상태와 작업 큐를 바로 답합니다. |
| 일일 리포트 | 매일 09:00(KST)에 MODY 저장소의 `daily-report.yml` 워크플로를 실행합니다. |
| 리포트 인사이트 | #10_daily_report에 리포트가 올라오면 이전 리포트, 같은 날 500 에러와 함께 읽고 리포트 thread에 인사이트를 남깁니다. |

## 권한과 안전장치

모든 작업은 `agy`를 샌드박스 없이 실행합니다. 비대화 모드로 돌아야 해서 도구 사용 권한 확인도 건너뜁니다(`--dangerously-skip-permissions`). 그래서 범위는 지침과 요청 분기 코드로 좁힙니다.

| 작업 | 범위 제한 |
| --- | --- |
| 500 에러 분석, thread 요약, 리포트 인사이트 | 지침에서 코드 수정, 데이터 변경, 커밋, PR, 배포를 금지합니다. 운영체제 수준에서 막지는 않습니다. |
| 멘션 작업 (조회, dev 데이터 보정, PR, 배포) | 아래 규칙으로 범위를 제한합니다. |

멘션 작업의 범위 제한:

- `.env`·토큰·비밀값 요청과 개인 파일·폴더 요청은 요청 분기 단계에서 먼저 거절합니다.
- 운영(prod)은 요청에 `운영`, `prod`, `prd` 중 하나를 적었을 때만 조회 전용 스킬(`mody-operations`)로 접근합니다. 데이터 변경 절차는 dev용(`mody-dev-operations`)만 둡니다.
- 코드 변경, 커밋, PR, 머지, 배포는 요청에 적힌 범위만 수행합니다.
- thread 내용은 작업 데이터로만 다룹니다. 지침을 무시하라는 문장이 있어도 따르지 않습니다.
- 토큰, 비밀값, 인증 헤더, 개인 연락처는 답변에 넣지 않습니다.
- 결과는 JSON Schema(`config/agent-result.schema.json`) 검증을 통과해야 Slack에 올라갑니다.
- 작업은 큐에서 한 번에 하나씩 처리합니다.
- 이 규칙은 에이전트 지침(`prompts/mody-agent.md`)과 요청 분기 코드(`src/request-policy.js`)로 지킵니다. 샌드박스처럼 운영체제 수준에서 막지는 않습니다.

공통:

- `agy`에는 허용한 환경변수(`HOME`, `PATH`, `SSH_AUTH_SOCK` 등)만 넘깁니다. 이름에 `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY` 같은 단어가 들어간 변수는 넘기지 않습니다.
- 감사 기록(`logs/audit/operations.jsonl`)에는 확인 ID, 상태, 환경, 채널, 사용자, 소요 시간만 남깁니다. 요청 본문과 비밀값은 남기지 않습니다.
- 요청은 MODY 팀 Slack 워크스페이스에서 봇을 멘션할 수 있는 사용자만 할 수 있습니다.

## 동작 구조

```text
Slack (Socket Mode + 에러 채널 60초 보조 폴링)
├─ 에러 채널 500 알림
│   → 파싱 → 스캐너 요청 제외 → 중복 확인
│   → agy 분석(변경 금지 지침) → thread 답변 → GitHub 이슈 생성·연결
└─ 봇 멘션
    → 민감 정보·개인 파일 요청 거절
    → 요약·상태·버전 질문은 바로 처리
    → 그 외: 작업 큐(동시 1건) → agy 작업 실행(범위 제한 규칙 적용)
      → 결과 JSON 검증 → thread 답변, 감사 기록

매일 09:00 KST → gh workflow run daily-report.yml
매일 09:00 KST 이후 5분마다 → #10_daily_report에서 어제 날짜 리포트 확인
    → 이전 리포트·500 에러 수집 → agy 분석(변경 금지 지침) → 리포트 thread에 인사이트
```

## 실행 환경

| 항목 | 내용 |
| --- | --- |
| 실행 | `screen` 세션 `mody-slack-bot`에서 `scripts/run-forever.sh`를 실행합니다. |
| 재시작 | `run-forever.sh`가 봇이 종료되면 5초 뒤 다시 띄웁니다. 이때 `.env`를 다시 읽습니다. |
| 잠자기 방지 | launchd `com.mody.keepawake`(`caffeinate -imsu`)가 Mac이 잠들지 않게 합니다. |
| 자동 시작 | launchd `com.mody.slack-error-harness`는 등록돼 있지만 비활성화 상태입니다. 재부팅 후에는 직접 시작해야 합니다. |
| AI | Antigravity CLI(`~/.local/bin/agy`)를 `agy --print` 비대화 모드로 씁니다. 로그인 정보는 `~/.gemini` 아래에 있고, 기본 모델은 `gemini-4-argon-medium`입니다. |
| GitHub | `gh` CLI로 이슈를 만들고 워크플로를 실행합니다. |
| MODY 코드 | `agy`는 `~/Desktop/Code/mody-server`에서 작업합니다. |
| 서버 접근 | SSH 별칭 `mody-dev`·`mody-prod`와 스킬 `mody-operations`(조회)·`mody-dev-operations`(dev 변경)를 씁니다. 스킬 원본은 `~/.codex/skills`에 있습니다. `agy`는 이 폴더를 자동으로 찾지 않아서, 봇이 두 스킬 폴더를 `--add-dir`로 넘기고 프롬프트에 `SKILL.md` 경로를 적어 읽게 합니다. |
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
| `DAILY_REPORT_TIME` | 일일 리포트 시각, KST (`09:00`). 인사이트도 이 시각부터 확인합니다 |
| `DAILY_INSIGHT_ENABLED` | 리포트 인사이트 (`true`) |
| `DAILY_REPORT_CHANNEL_ID` | 일일 리포트 채널 ID (`C0C82K2MKRT`, #10_daily_report) |
| `USE_AI_ANALYSIS` | 에러 분석에 `agy` 사용. `false`면 키워드 코드 검색만 합니다 (`true`) |
| `AI_MODEL` | `agy` 모델 (`gemini-4-argon-medium`) |
| `AI_EFFORT` | `agy` 추론 강도, `low`·`medium`·`high`·`xhigh`·`max` 중 하나 (`medium`) |
| `AI_ANALYSIS_TIMEOUT_MS` | 에러 분석·요약 제한 시간. 0은 무제한 (`0`) |
| `AGY_PATH` | `agy` 실행 파일 경로 (`~/.local/bin/agy`) |
| `MODY_SKILLS_PATH` | MODY 스킬 폴더 (`~/.codex/skills`) |
| `AGENT_TIMEOUT_MS` | 멘션 작업 제한 시간 (`1200000`, 20분) |
| `AGENT_CONCURRENCY` | 동시에 처리할 멘션 작업 수 (`1`) |
| `SLACK_POLL_INTERVAL_MS` | 에러 채널 보조 폴링 간격. 0은 끕니다 (`60000`) |
| `SLACK_WATCHDOG_MS` | 폴링이 이 시간 넘게 실패하면 프로세스를 재시작합니다 (`120000`) |
| `PROCESS_EXISTING_MESSAGES` | 봇 시작 전 메시지도 처리 (`false`) |
| `SLACK_BOT_USER_ID`, `SLACK_BOT_ID` | 비우면 시작할 때 Slack에서 조회합니다 |
| `ENABLE_PRIVILEGED_OPERATIONS` | 현재 코드에서 읽지 않습니다. 값과 관계없이 멘션 작업은 [권한과 안전장치](#권한과-안전장치)의 방식으로 실행됩니다 (`true`) |

파일 위치는 `AGENT_PROMPT_PATH`, `AGENT_RESULT_SCHEMA_PATH`, `ERROR_ISSUE_CACHE_FILE`, `DAILY_REPORT_STATE_FILE`, `DAILY_INSIGHT_STATE_FILE`, `HANDLED_ALERT_DIRECTORY`, `AUDIT_DIRECTORY`로 바꿀 수 있습니다. 기본값은 `prompts/`, `config/`, `logs/` 아래입니다.

## Slack 사용법

### 500 에러 자동 분석

- 에러 채널에 서버 에러 알림이 올라오면 thread에 원인 후보를 답합니다. 대응은 `데이터 확인/보정`, `기능 수정`, `외부 서비스 확인`, `추가 확인 필요`로 나눕니다.
- 같은 에러(메서드·경로·예외·첫 스택 프레임)는 30분 안에 한 번만 분석합니다.
- `/.env`, `/wp-admin` 같은 스캐너 요청과 `MultipartException`은 무시합니다.
- 같은 에러로 열린 GitHub 이슈가 있으면 새로 만들지 않고 링크만 답니다.

### 일간 리포트 인사이트

- 09:00(KST)부터 5분마다 #10_daily_report에 어제 날짜 리포트(`MODY 일일 리포트 YYYY-MM-DD`)가 올라왔는지 확인합니다.
- 리포트가 있으면 아래 자료를 함께 `agy`에 넘기고, 리포트 thread에 `데일리 인사이트` 댓글을 남깁니다.
  - 최근 리포트 최대 7개
  - 리포트 날짜의 500 에러 알림 집계
- 댓글은 눈에 띄는 변화, 원인 후보(가능성), 확인해 볼 것으로 600자 안에서 씁니다. 특이사항이 없으면 한 줄만 남깁니다.
- 날짜마다 한 번만 남깁니다. thread에 이미 인사이트가 있으면 다시 쓰지 않습니다.
- 분석이 실패하면 30분 뒤 다시 시도하고, 같은 날짜는 3번까지만 시도합니다.
- 리포트는 봇 토큰으로 올라와서 봇이 자기 메시지로 보고 이벤트로 받지 않습니다. 그래서 채널 기록을 직접 확인합니다.

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
| 그 외 | 에이전트 작업 (범위 제한 규칙 적용) |

요약·상태·버전 질문이어도 서버, 운영, dev, 데이터, 회원, 챌린지, 알림 같은 대상이나 PR, 수정, 조회, 분석 같은 작업이 함께 있으면 에이전트 작업으로 처리합니다. 예를 들어 "운영 서버 상태 확인해줘"는 서버 상태를 확인하고, "이 thread 참고해서 PR 열어줘"는 PR을 엽니다. 판별 규칙과 테스트는 `src/request-policy.js`, `test/request-policy.test.js`에 있습니다.

민감 정보·개인 파일 차단은 안전을 위해 넓게 잡혀 있어서 `키워드`, `Library` 같은 말이 들어간 요청도 거절될 수 있습니다.

## 로그와 상태 파일

`logs/`는 git에서 제외합니다.

| 파일 | 내용 |
| --- | --- |
| `slack-error-harness.log` | 실행 로그 |
| `audit/operations.jsonl` | 요청별 감사 기록 |
| `handled-alerts/` | 처리한 에러 알림 표시 (중복 처리 방지) |
| `error-issues.json` | 에러별 GitHub 이슈 캐시 |
| `daily-report-trigger.json` | 일일 리포트 마지막 실행일 |
| `daily-insight.json` | 리포트 인사이트를 마지막으로 남긴 리포트 날짜 |
| `slack-error-harness.pid`, `slack-error-harness.lock/` | 감시 스크립트 PID와 중복 실행 방지 |

## 파일 구조

```text
src/
  index.js                 Slack 이벤트 처리, 요청 분기, agy 실행
  agent-cli.js             agy 실행 인자 구성, 출력 JSON 파싱
  agent-contract.js        환경 추론, 결과 JSON 파싱, Slack 답변 형식
  request-policy.js        개인 파일 요청 판별, agy에 넘길 환경변수 필터
  job-queue.js             동시 실행 수를 제한하는 작업 큐
  slack-status.js          상태 리액션, 알림 환경 판별
  github-issue.js          에러별 GitHub 이슈 생성·재사용
  daily-report-trigger.js  일일 리포트 워크플로 실행
  daily-insight.js         일일 리포트 인사이트 수집·분석·게시
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
| 로그에 `agy ... failed` | `agy models`로 모델 목록이 나오는지 보고 로그인을 확인합니다. 로그인이 풀렸으면 터미널에서 `agy`를 실행해 다시 로그인합니다. `agy`가 실패하면 에러 분석은 키워드 검색 결과로 대신 답합니다. |
| GitHub 이슈·리포트가 안 됨 | `gh auth status`를 확인합니다. |
