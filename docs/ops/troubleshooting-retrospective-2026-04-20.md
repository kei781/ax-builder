# Troubleshooting Retrospective — 2026-04-19 ~ 20

Phase 6 MVP 배포 직후 유저가 실제 앱을 사용하면서 **연쇄적으로** 드러난 버그 네 건을 한 사이클에 추적·수정한 기록. 각 버그의 원인보다 **공통 패턴**과 **예방 체계**에 초점을 둔다.

## 1. 발생 순서

| # | 증상 (유저 언어) | 1차 진단 | 실제 원인 |
|---|---|---|---|
| 1 | "되돌아왔는데 왜 상단에 이유가 안 써있냐?" | UI 누락 | ① findOne이 state='failed'일 때만 failure_reason 반환 → planning 상태엔 없음. ② building.runner가 bounce 시 `closeBuild(id, 'bounced')`에 gap_list 인자 누락 → DB에 아예 저장 안 됨 |
| 2 | "근데 왜 클로드 코드가 알아서 시도 안 하냐?" (위 배너에 "기획 대화로 돌아가세요" 찍혀있음) | AI agent가 능동적으로 고쳐야 할 텐데 | **Claude CLI OAuth 토큰 만료(401)** — credential 문제라 재시도 무의미. orchestrator가 infra 오류를 "기획 부족"으로 오분류. FailureClassifier가 env_qa에만 적용되고 build phase 실패에는 안 적용됐음. |
| 3 | "AX_AI_TOKEN이라고만 나오면 뭘 넣어야 하는지 어캐 아냐?" + "AI 토큰은 MCP로 일괄처리하기로 하지 않았나?" | UX 혼란 | Claude Code가 `.env.example`을 **그룹 헤더 스타일**로 생성 (`# 주입: system-injected` 한 줄 아래 변수 둘). 파서가 변수마다 메타를 리셋하는 구조 → 첫 변수만 system-injected 적용, 둘째는 user-required 기본값. AX_AI_TOKEN이 유저 UI에 노출됨. |
| 4 | "패스워드 1111로 설정했는데 왜 로그인 안 되냐?" | DB 저장 실패? | ① 생성 앱이 `require('dotenv').config()`를 호출 안 함 → .env 파일 있어도 process.env에 안 올라감. ② Docker `Env` 배열은 createContainer 시점에 고정 — `docker restart`로는 갱신 불가. envs가 파일에만 썼고 Docker Env엔 안 넘김 → 결과적으로 앱은 env 값을 못 봄. |

## 2. 공통 패턴

### 2.1 "계약을 말했지만 강제는 안 했다"

각 버그의 뿌리엔 **지켜야 할 계약을 선언만 하고 보장 장치는 없음**이 있다.

| 계약 | 누구의 책임이었나 | 실제로 어긴 주체 |
|---|---|---|
| "QA/build phase 실패 시 gap_list를 DB에 영속한다" | building.runner | 인자 누락으로 NULL 저장 |
| "실패 종류에 따라 다른 상태로 라우팅한다" | FailureClassifier | env_qa에만 적용 (build phase는 규칙 밖) |
| "AX_* 변수는 시스템 전용, 유저에 노출 X" | env-parser + Claude Code 프롬프트 | 파서가 그룹 헤더를 못 읽어서 둘째 변수 누락 |
| "env 값이 컨테이너에서 읽혀야 한다" | 생성 앱 (dotenv 로드) + docker.service (Env 주입) | 둘 다 안 함 — 앱은 dotenv 안 부르고, docker는 Env에 안 넣음 |

**교훈**: 계약은 **경계에서 강제**해야 한다. 생성되는 코드(Claude)나 유저 입력을 신뢰하면 언젠가 깨진다. 파서 레벨에서 네임스페이스 강제, Docker 레벨에서 env 주입, DB 레벨에서 NOT NULL constraint — 이런 식으로 **가장 바깥 경계에서 불변식을 보장**한다.

### 2.2 "투명성이 없으면 뭘 고칠지도 모른다"

- 버그 #1: gap_list가 저장 안 된 사실을 유저는 모름 → "왜 돌아왔는지 궁금해" 수준에서 멈춤. 내부(agent_logs)엔 정보가 있었는데 경계를 못 넘어옴.
- 버그 #2: classifier가 "code_bug" 폴백 하나만 가지면 유저·AI·운영자 중 누구도 구분 안 됨 → 잘못된 행동 유도.
- 버그 #4: `.env`는 생성됐는데 앱이 못 읽는 실상이 **로그에 전혀 안 남음**. docker exec + 수동 echo로 겨우 확인.

**교훈**: 상태 전이·분류 결과·주요 부작용은 **항상 observable**해야 한다. WS 이벤트, 상세 배너, DB 영속(값 + 분류 + 근거) 세트.

### 2.3 "E2E 전까지는 버그가 숨는다"

네 건 모두 **유저가 실제 UI를 클릭하거나 앱을 써본 뒤에만** 발견됐다. 코드 리뷰·TypeScript·단위 테스트로는 못 찾는 종류:

- #1: planning state에 failure_reason이 없다는 건 UI에서 직접 봐야 알음
- #2: "기획 대화로" 문구는 결과 페이지 맥락에서만 어색함을 인지
- #3: AX_AI_TOKEN 입력 폼을 본 순간 "어 이거 왜 여기 있지"
- #4: 로그인 안 됨은 컨테이너 안에서 process.env 확인해야 원인 나옴

**교훈**: MVP 단계에서도 **E2E 스모크 테스트가 실질적인 버그 탐지기**. 유닛 테스트는 리팩터 안전망일 뿐.

## 3. 앞으로 어떻게 할 것인가

### 3.1 즉시 도입 (작음)

**A. 관찰성 기본값 강화**
- 상태 전이 로그를 WS로 **항상** 방출 (현재는 특정 이벤트에만). 프론트 Chat에 "최근 상태 변경" 타임라인 추가.
- Classifier verdict는 **모든 실패 경로**에서 이벤트 payload에 포함. "왜 이 분류인지" snippet 함께.
- `project_env_vars` 변경 시 Δ를 WS로 알려서 UI가 즉시 갱신.

**B. 에러 사용자 텍스트를 classifier 기반으로**
현재 `failure_reason`이 free-form 문자열. kind 정보도 같이 내려주면 프론트가:
- `infra_error` → 빨간 "운영자 문의" 배너 + 관리자 연락처
- `transient` → 파랑 "잠시 뒤 재시도"
- `code_bug` → 주황 "기획 대화로" 버튼
- `env_rejected` → 주황 "값 확인"

(Phase 6.1 항목으로 이미 ADR 0002에 있음 — 지금 구현에 `last_bounce.classifier` 필드 추가만 하면 됨)

### 3.2 중기 (E2E 테스트 하네스)

**C. 스모크 테스트 스크립트** — `scripts/e2e-smoke.sh`
```
1. JWT 발급 + 테스트 유저로 프로젝트 생성
2. Planning 대화 시드 (고정 프롬프트)
3. 빌드 트리거, 완료 대기 (최대 20분)
4. 배포된 앱 URL에 HTTP 200 확인
5. 생성된 app이 받아야 할 env 중 하나 설정 (예: ADMIN_PASSWORD=test123)
6. /restart + 헬스 대기
7. docker exec로 해당 env가 process.env에 있는지 확인
8. app의 해당 기능 엔드포인트에 실제 값 전달해서 동작 검증
9. AX_AI_TOKEN이 유효하면 Gateway → Gemini까지 관통하는 chat/completions 요청 1회
10. 각 단계 PASS/FAIL 출력
```

이 하나가 돌면 네 버그 중 3개는 도입 시점에 걸렸을 것.

**D. 분류 통계 대시보드**
`build_phases.failure_kind` 컬럼 승격 (현재 agent_logs에만). kind 분포가 쌓이면:
- `code_bug` 비율 높음 → Claude Code 프롬프트 보강 신호
- `env_rejected` 비율 높음 → env 가이드 UI 개선 신호
- `infra_error` 비율 급증 → 운영 환경 점검 알림

### 3.3 장기 (구조적 변화)

**E. 생성 앱의 런타임 계약을 테스트 가능하게**
현재 Claude Code가 지켜야 할 규칙을 프롬프트로만 전달. 대안:
- 스캐폴드 QA를 확장해 `.env.example` 메타라인 규격, provider 키 가드, mock/real 분기 등을 **정적 분석으로 체크** → 실패 시 build agent가 Claude에게 피드백 루프 한 번 돌리기
- 일종의 "생성 앱 스펙 준수 linter"

**F. 환경 컨트랙트의 명시적 버전화**
`AX_AI_*`, `AX_STORAGE_*`, `PORT=3000` 등 플랫폼→앱 계약을 `platform-contract.md`로 단일 SSoT에 정리. 계약 변경 시 major 버전 올리고 기존 생성 앱에 migration 가이드 발행.

## 4. 이번 사이클이 준 신호

네 건 모두 **아키텍처의 깊은 구조 오류는 아니다** — ADR 0002/0003/0004/0005/0006가 그려놓은 큰 그림은 여전히 맞다. 모두 **구현 경계의 디테일**이 비어있었던 것. 즉 플랫폼의 골조는 유효하고, 지금 필요한 건:

1. **"선언→강제" 격차 줄이기** (경계에서의 가드·검증)
2. **관찰성 기본값 올리기** (내부 상태를 UI까지 승격)
3. **E2E 스모크 하네스** (유저 역할을 스크립트가 대신)

유저 메시지 한 줄("왜 안되냐")이 가장 강력한 regression 탐지기로 작동하는 동안은 플랫폼이 살아있는 피드백 루프를 가진 셈. 이게 유지되게 하려면 **문제 제기가 빠르게 고칠 수 있는 형태로 내려오도록** — 배너·분류·로그가 단계마다 있어야 한다.

---

## 5. 추가 사건 — orchestrator hot-reload 고아 빌드 (2026-04-20 후속)

### 5.1 증상

유저: "140분째 67%래 확인좀해봐." 스크린샷은 `backend_llm_logic (running)` phase 진행바가 2시간 20분째 67% 멈춤.

### 5.2 원인

`CLAUDE_PHASE_TIMEOUT_S=900`(15분)인데 2시간 20분 경과 → 정상이면 이미 `TimeoutExpired`로 bounce됐어야 함. 진단:

1. `ps aux`로 `python3 orchestrator.py`, `claude` 바이너리 둘 다 **없음**.
2. orchestrator(nest start --watch) 프로세스는 빌드 시작 시각(04:30 UTC) 이후인 06:20 UTC에 재시작됨.
3. 즉 **개발 중 파일 저장이 hot-reload를 트리거하면서 orchestrator가 죽었고, 자식 `building-agent` subprocess가 고아로 남았다가 어느 순간 사라짐**. `processes` Map은 리셋됐지만 DB의 `build_phases.status='running'` / `builds.status='running'` / `projects.state='building'`은 그대로.

UI는 DB 기준으로 렌더링하므로 영원히 "진행 중". 유저가 할 수 있는 건 프로젝트 삭제뿐이었음 (중단·재시작 UI가 없었음).

### 5.3 근본 문제 — "계약 불변식: 상태는 실제 프로세스를 반영한다"

"선언→강제" 격차 패턴의 또 다른 사례. `state='running'`이라는 선언이 실제 프로세스 존재를 **보장한다고 가정**한 코드가 여러 곳에 있었지만, 부모 프로세스 재시작이라는 경계 이벤트에서 이 불변식이 깨짐.

§2.1~2.3의 4건은 **한 프로세스 안에서의 계약**이었고, 이번은 **프로세스 재시작 경계에서의 계약**이라는 차이.

### 5.4 대응 (같은 날 적용)

- `POST /projects/:id/build/cancel` — BuildStatus UI에 중단 버튼 노출. 프로세스 Map에 없어도 DB만 정리하고 state `failed`로 (또는 update 라인이면 previous 복구).
- `POST /projects/:id/build/retry` — 실패 상태 + 유효 handoff면 `failed → plan_ready → building` 원자 전이. 유저가 "그냥 다시 돌려보기"로 복구.
- `BuildingRunner.onModuleInit()` — startup 훅에서 `building / qa / updating / update_qa` 상태 프로젝트 전수 검사 후 고아 확정 시 자동 정리. orchestrator가 재시작되기만 하면 **사용자 개입 없이** 복구. 이게 근본 해결.

### 5.5 교훈 추가

- **부모 프로세스 lifecycle 훅은 기본 장착**. `onModuleInit` 같은 startup hook은 "프로세스 사라진 동안 시스템이 거짓말한 DB row"를 감지할 유일한 지점. 선택이 아니라 기본.
- **dev 환경도 운영 계약을 배신하면 안 됨**. `--watch`가 프로덕션에 안 돈다고 무시하면 개발 중 stuck이 반복돼 신뢰가 갉아먹힘. dev 경험이 곧 제품 신뢰.
- **"유저가 삭제 외엔 할 게 없다"는 UX 실패 신호**. 장시간 진행 중 화면엔 언제나 중단 버튼, 실패 화면엔 재시도/대화 분기 — 한 번에 설계에 포함.

---

## 6. 추가 사건 — propose_handoff 환각 + code_bug 오남용 (2026-04-20 후속)

### 6.1 증상

유저: 배포된 앱의 첫 빌드가 `npm start exit=1`로 bounce됨 → chat으로 돌아옴 → PRD를 전혀 안 고치고 "propose_handoff 호출해줘" 재요청.

- 1차 AI 응답: "점심 메뉴 추천 앱의 기획이 다음 단계로 성공적으로 이관되었습니다" (거짓)
- 2차 AI 응답 (같은 요청): "아직 plan_ready 상태로 전환되지 않았습니다... is_sufficient가 false"
- 사이드바: 5개 항목 전부 초록 풀 + "빌드 가능" 배지

### 6.2 원인 세 겹

1. **AI 환각**: 1차 턴에서 propose_handoff 호출은 했지만 결과(accepted=false)를 잘못 요약해 "이관 완료"라고 거짓 보고. `system_prompt.py`에 "⛔ 절대 금지" 섹션이 있었음에도 깨짐.
2. **UI 지표 불일치**: 사이드바 "빌드 가능"은 `can_build` (min>=0.6) 기준, propose_handoff accepted는 `is_sufficient` (min>=0.85) 기준. 두 지표가 서로 다른 임계값을 쓰면서 UI에서는 하나만 표시 → 모순적 신호.
3. **과도한 planning 반송**: 첫 빌드 실패 시 `code_bug`로 분류되면 자동 planning 반송. 하지만 Claude Code 실행은 확률적이라 같은 PRD로 재시도 시 풀리는 케이스가 흔함. PRD가 실제로 틀린 게 아닌데도 유저를 "기획 수정" 맥락으로 몰아감.

부가: 배너에 동일 메시지(`npm start`가 즉시 종료…)가 **두 번** 표시됨 — `phase_end` + `error` 이벤트에서 같은 gap_list를 양쪽 누적한 결과.

### 6.3 근본 문제 — "도구 결과 vs AI 설명 vs UI 지표의 3자 불일치"

§2.1의 "선언→강제" 격차의 또 다른 표면:
- **도구(propose_handoff)가 accepted=false를 반환**했는데
- **AI가 accepted=true로 요약**했고
- **UI는 독립 지표(can_build)로 '빌드 가능' 표시**

세 신호가 제각각. 유저는 어느 쪽을 믿어야 할지 판단 불가.

### 6.4 대응 (같은 날 적용)

- **도구 결과를 UI가 직접 표시**: `chat.service.handleAgentEvent`가 `propose_handoff` tool_result를 감지해 전용 이벤트(`phase=plan_ready` / `update_ready` / `handoff_rejected`) emit. 프론트 배너가 AI 텍스트와 별도로 "진실"을 표시. AI 환각 여부와 무관한 단일 진실원.
- **사이드바 3단계 구분**: `is_sufficient` (초록), `can_build && !is_sufficient` (노랑, "보강 권장"), 그 외 (빨강). 노란 상태에선 "propose_handoff가 거부될 수 있어요" 경고 명시.
- **retry-first 정책**: `code_bug` / `unknown`이 첫 빌드 라인에서 자동 planning 반송되지 않고 `failed`로 수렴. 유저가 "↻ 다시 빌드" vs "기획 대화로" 선택. **2회 연속 실패** 시 CTA primary를 "기획 대화로"로 뒤집음 (ARCHITECTURE §7.6).
- **gap_list dedupe**: `building.runner`가 Set 기반으로 같은 gap 중복 축적 차단. `projects.service.parseGaps`도 legacy row 대비 dedupe.

### 6.5 교훈 추가

- **환각은 프롬프트만으로 못 막는다**. 시스템 프롬프트에 "도구 결과를 그대로 요약하라" 적어도 LLM은 어긴다. 해법은 UI 레벨에서 **도구 결과를 직접 표시**하고 AI 텍스트를 보조로 내리는 것.
- **같은 개념에 대한 지표는 하나의 임계값으로 통일하거나, 여러 단계임을 명시적으로 노출**. `can_build`와 `is_sufficient`를 섞으면 안 되고, 합친 1지표 또는 3단계 스펙트럼 둘 중 하나.
- **자동 반송은 신뢰의 빚**. "시스템이 판단해서 돌려보냄"은 시스템 신뢰가 높을 때만 허용되는 UX. 신뢰 부족 단계에선 유저 선택권을 남겨둬야 한다. Claude Code가 확률적인 이상 retry-first가 기본값이어야.

---

## 7. 추가 사건 — 포트 3000 좀비 컨테이너 + QA 하드코딩 충돌 (2026-04-20 후속)

### 7.1 증상

서로 다른 3개 프로젝트("점메추", "랜덤 간식 당번", "SNS 메시지 자동 답변")가 **같은 사유로 연속 실패** (09:05:10~09:05:44, 34초 간격):
- gap_list: "`npm start`가 즉시 종료됐어요 (exit=1). 런타임 에러 확인 필요."

유저: "이게 다 말이 되냐?"

### 7.2 원인

QA 로그를 보니 실제 에러는 `Error: listen EADDRINUSE: address already in use :::3000`. 3건 모두 포트 3000 충돌.

`lsof`로 보니 Docker 컨테이너 `project-5f1e10a8-…`이 5시간째 **호스트 포트 3000 점유**. 이 프로젝트의 DB 상태는 `state='failed', port=3000, container_id='27dc1d…'` — **빌드 실패 후 컨테이너 정리 안 된 좀비**.

port-allocator의 점유 판정 쿼리:
```ts
state: In(['building', 'qa', 'deployed', 'modifying']),
```

문제 3겹:
1. **`failed` 상태 누락**. 컨테이너가 살아있어도 "비어있는 포트" 취급 → 같은 3000을 다른 새 빌드에 재할당.
2. **state enum 구식**. `modifying`은 ADR 0008에서 제거됐고, 새로 생긴 `updating/update_qa/env_qa/planning_update`가 전부 빠져 있음 — 이들이 컨테이너를 갖는 상태인데도.
3. **DB만 봄**. OS에서 실제로 그 포트가 바인드 가능한지는 체크 안 함. 외부 프로세스·좀비·테스트 서버 등 DB 밖 점유자를 못 봄.

그리고 본질적으로: QA가 호스트 Node 프로세스를 직접 띄우는데 앱들이 전부 `app.listen(3000)` 하드코딩. 누군가 이미 3000을 쓰면 모든 새 빌드 실패.

### 7.3 근본 문제 — "자원 점유 판정은 DB가 아니라 OS가 진실원"

§5 "상태는 실제 프로세스를 반영한다"의 또 다른 표면. 포트 점유 여부도 마찬가지 — DB의 projects.port 필드는 **할당 기록**이지 **실시간 점유 상태**가 아니다. state 전이가 실제 프로세스 라이프사이클을 반영하지 못하면(failed인데 컨테이너 살아있음), DB 판정은 거짓.

그리고 QA가 호스트 네트워크에 직접 바인드하는 설계는 "앱이 하드코딩해도 괜찮다"(ADR 0001 관찰 QA)는 철학과 결합해 **동시 실행 불가능한 구조**를 만듦.

### 7.4 대응 (같은 날 적용)

1. **port-allocator 재작성** (`infra/port-allocator.service.ts`):
   - state 조건 제거, 대신 `container_id IS NOT NULL OR port IS NOT NULL` 모든 row를 점유로 간주 (좀비 방어).
   - **블랙리스트**: 3000/3001/5000/5173/5174/8000/8080 + 플랫폼 예약(4000/4100)은 배포 호스트 포트로 할당 안 함. 앱이 흔히 하드코딩하는 포트를 배포에 쓰면 같은 앱 QA에서 충돌 유발.
   - **OS 레벨 bind 체크**: `net.createServer().listen(port)` 테스트로 실제 바인드 가능한지 확인. 실패하면 skip.

2. **QA 포트 격리** (`qa_supervisor.py`):
   - OS에게 빈 포트를 받아 `PORT` env로 주입 (`socket.bind('', 0)`).
   - 앱이 `process.env.PORT` 존중하면 격리 성공, 안 하면 observation fallback.
   - **EADDRINUSE 감지**: 앱이 PORT 무시하고 하드코딩한 포트가 이미 점유 중이면 에러 로그 파싱해 "앱이 PORT={qa_port} 무시하고 {3000}에 바인드 시도" 메시지 + "하드코딩 대신 `process.env.PORT || 3000` 패턴 써야 함"으로 유저/AI에게 원인 구체화.

3. **Claude Code 프롬프트 강화** (`phase_runner.py`): "PORT env 존중은 필수 아님 — 하드코딩해도 무방"을 **"반드시 PORT env 우선, 하드코딩 금지"**로 뒤집음. 이유("QA·배포 병렬 기동, 3000 하드코딩 시 두 번째부터 EADDRINUSE")도 포함.

4. **좀비 컨테이너 정리**: 실행 중인 좀비 수동 제거 + projects.port/container_id clear. (추후 빌드 실패 경로에서 자동 정리하도록 별도 작업 필요 — §7.5.)

### 7.5 교훈 + 후속

- **할당자(allocator)는 자신의 기록만 믿지 말라**. DB 쿼리는 시작점이지 결론이 아니다. OS의 실제 상태(bind 가능 여부, 프로세스 존재 여부)로 교차검증.
- **하드코딩을 "허용"하는 시스템은 시간 지나면 깨진다**. ADR 0001의 "관찰 QA"는 단일 앱 테스트엔 맞지만 병렬 기동 환경에는 약함. 앱 측 규율(PORT env 존중)을 명시적으로 요구하는 게 장기적으로 건강.
- **후속 작업** (완료 — 같은 날): `BuildingRunner.cleanupFailedContainer()` 헬퍼 신규. 첫 빌드 라인의 모든 failure 경로(handleExit의 infra/transient/code_bug/unrecoverable, cancel의 rollback 불가 분기)에서 호출해 `docker rm -f` + projects.port/container_id clear. 업데이트 라인은 previous 유지 불변식 때문에 호출 안 함. 추가로 `onModuleInit`에 "state=failed인데 container_id 살아있는" 좀비 스위프 단계도 추가 — 재시작마다 과거 누적 좀비 자동 정리. 예방이 탐지·복구보다 싸다.
