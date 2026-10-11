# 작업 규칙

- 이 폴더는 git으로 관리한다. 수정 전에 `.bak` 사본을 만들지 않고, 변경 단위로 커밋한다.
- `.env`와 `logs/`는 커밋하지 않는다. 토큰 값은 출력하지 않는다.
- 변경 후 `npm run check`와 `npm test`를 실행한다.
- 봇은 `screen` 세션 `mody-slack-bot`에서 `scripts/run-forever.sh`로 실행 중이다. 코드 변경은 `node src/index.js` 프로세스가 다시 시작돼야 반영된다. 감시 스크립트는 그 프로세스가 끝나면 5초 뒤 다시 띄운다.
