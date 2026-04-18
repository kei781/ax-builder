# ADR 0001: 관찰 기반 QA (포트 주입 폐지)

- **상태**: Accepted
- **일시**: 2026-04-19
- **관련**: PRD §7.6, §8.1

## 배경

초기 QA는 `PORT=3999` 환경변수를 주입하고, `curl localhost:3999/health`를 기다렸다. Claude Code가 생성한 앱이 `process.env.PORT`를 존중하지 않고 포트를 하드코딩하면 (관찰 사례: `Server running on port 3666`), QA는 영원히 타임아웃하고 빌드는 Planning으로 반송된다.

PRD §7.6의 "PORT 환경변수 우선" 규칙은 Claude Code가 따르지 않을 수 있는 **관례**였다. 프롬프트 규칙 1줄로 LLM 순종을 강제하는 것은 신뢰할 수 없다.

## 결정

QA는 포트를 **주입하지 않고 관찰**한다.

1. `npm start`를 PORT env 없이 실행.
2. 프로세스 pid 기준으로 LISTEN 소켓 목록을 스캔 (`lsof -a -iTCP -sTCP:LISTEN -p <pid>` 혹은 `/proc/<pid>/net/tcp`).
3. 복수 포트면 각 포트에 `/` HEAD 요청 → 2xx/3xx 반환 포트 채택.
4. 채택된 포트를 `build_phases`·`projects`에 기록하고 Nginx/Cloudflare 라우팅 설정.
5. 관찰 실패는 FailureClassifier(ADR 0002)가 원인 분류.

## 대안

- **A. 프롬프트 강화로 PORT env 존중 강제**: 불확실. LLM이 규칙을 일관되게 지키지 않는 것은 이미 관찰됨.
- **B. AST 파싱으로 소스에서 포트 추출**: 프레임워크마다 다른 표현을 파싱해야 함. 관찰 방식이 더 언어·프레임워크 중립적.
- **C. 지금 방식(주입) 유지 + 린터**: 소스를 grep해서 `process.env.PORT` 참조 여부 확인. 가능하지만 관찰 방식이 더 단순하고 Claude Code의 자유도도 높음.

B는 장기적으로 병행 가치 있음(정적 프리체크 용도) — 지금 결정하지 않음.

## 결과

**장점**
- Claude Code가 어떤 포트를 고르든 상관없음 → 프롬프트가 단순해짐.
- 실패 분류가 명확해짐: 바인드 실패 = 런타임 크래시, 바인드 했는데 응답 없음 = 라우팅/핸들러 문제.
- 컨테이너 내부 포트 자유도 → 배포 단계에서 `-p 호스트:컨테이너` 매핑만 하면 됨.

**단점 / 주의**
- 앱이 **부팅 실패**(즉시 종료)하면 관찰 대상 없음. FailureClassifier가 로그로 원인 추적.
- 여러 포트 바인드(예: metrics 9090 + 앱 3000) 가능성. HTTP 프로빙으로 2xx/3xx 포트 자동 선택.
- 30초 타임아웃. 초기화가 길어지는 프레임워크(프리워머 있는 Python 등)에선 부족할 수 있음 — 설정 가능하게.

## 연관 구현

- `building-agent/qa_supervisor.py` — `run_qa` 전면 리팩터.
- `orchestrator/src/agents/building.runner.ts:290` — `phase_end` 페이로드에서 `detail`·`gap_list` 수신하도록 수정 (현재 `stdout_tail`/`stderr_tail` 키만 처리하여 QA 실패 사유가 DB에 유실되는 버그).
- `phase_runner.py:42` PHASE 프롬프트 템플릿 — `PORT` env 관련 문구 제거, "원하는 포트에 바인드하면 됩니다" 문구 추가.
