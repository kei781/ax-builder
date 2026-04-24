# ADR 0002: FailureClassifier — QA 실패를 책임 주체로 분기

- **상태**: Accepted
- **일시**: 2026-04-19
- **관련**: PRD §8.3, §9.1, §10.1

## 배경

기존 정책은 "QA 실패 = 즉시 Planning 반송"이었다. 하지만 실제 실패 원인은 다양하다:

- 유저가 API 키 오타를 냈다 → "기획부터 다시"는 비합리적.
- 외부 서비스가 일시적으로 503 → 잠깐 뒤 재시도만 해도 성공.
- 앱 코드에 `TypeError` → 이건 진짜 Claude Code가 잘못 짠 것. 기획 반송이 맞음.
- env 스키마 자체가 잘못 정의 → 유저가 3번 재입력해도 계속 실패.

한 덩어리의 "실패"를 네 가지로 분리해서 **고칠 수 있는 주체**에게 돌려야 한다.

## 결정

**5-way 분류기**를 도입한다.

| # | 원인 | 고치는 주체 | 시그니처 예 | 핸들링 |
|---|---|---|---|---|
| 1 | `infra_error` | **운영자** | Claude CLI auth 401, rate-limit 429, context overflow, OOM, disk full, docker daemon down | `state='failed'` + "관리자에게 문의" 메시지. 기획·유저·AI 다 손댈 수 없음. |
| 2 | `env_rejected` | 유저 | 401, 403, Unauthorized, Invalid.\*key | `awaiting_env` 복귀 (또는 mock-first 흐름에선 `deployed` 유지 + 토스트), 최대 3회 재입력 |
| 3 | `transient` | 아무도 (대기) | ECONNREFUSED, ETIMEDOUT, 503, 502 | 현 상태 유지 + "잠시 뒤 재시도" 안내. 자동 retry는 Phase 6.1. |
| 4 | `code_bug` | AI (Claude Code) | SyntaxError, TypeError, ReferenceError, 포트 미바인드, 파싱 실패 | env_qa에선 `modifying` (대화 수정), phase 실행 실패에선 `planning` bounce. |
| 5 | `schema_bug` | AI (PRD/Planning) | 같은 변수에서 env_rejected가 3회 연속 | `planning` bounce-back (변수 이력 첨부). |
| — | `unknown` | — | 규칙 미매칭 | `code_bug`로 안전 폴백 (유저를 재입력 지옥에 두지 않음) |

**`infra_error` 추가 배경 (2026-04-20)**: 실제 운영에서 **Claude CLI OAuth 토큰 만료 → 401 → phase 실패 → "기획 대화로 돌아가세요"** 잘못된 안내 사례 발생. 유저가 기획을 아무리 바꿔도 해결 안 되는 종류이므로 PRD bounce가 아니라 **관리자 개입 필요** 상태로 분리 필요. `claude-auth-failed` regex 룰이 env_rejected의 `http-401` 룰보다 먼저 매칭되도록 RULES 테이블 순서 배치.

**판정 순서**
1. **regex 룰 테이블** — 에러 로그에 대한 1차 매칭. 확정되면 즉시 분기.  `infra_error` 룰이 최우선 — auth/rate/infra 신호가 있으면 env_rejected/transient의 겹치는 신호(401 등)보다 먼저 가로챈다.
2. **LLM judge** (Gemini `qa_judge` 슬롯) — 1차에서 미매칭 시 2차. 프롬프트: "infra/env/transient/code 중 무엇인가". **Phase 6.1 구현 예정**.
3. **안전 폴백** — 2차도 모호하면 `code_bug`로 처리.

## 대안

- **A. 전부 LLM judge**: 프롬프트 비용·레이턴시 부담. regex로 거를 수 있는 80%는 무료로 거르는 게 낫다.
- **B. 고정 룰만**: 로그가 규칙 밖일 때 분류 불가. 다양한 프레임워크·언어 대응 불가.
- **C. 분기 없이 전부 유저에게 표시**: 비개발자가 `TypeError` 로그 보고 판단할 수 없음. UX 참사.

## 결과

**장점**
- 비개발자 UX가 극적으로 개선 — "키 틀려서 다시 입력하세요"와 "앱 코드 버그라 기획부터 다시"가 명확히 구분됨.
- Planning 반송 비용 절감 — 불필요한 Gemini·Claude Code 호출 감소.
- 에러 분포 통계로 플랫폼 병목 파악 가능 (env_rejected가 많으면 가이드 개선, code_bug가 많으면 프롬프트 강화 등).

**단점 / 주의**
- 분류가 틀릴 수 있음 — 401이 실제로는 서버 버그일 수도 있다. 폴백 정책 중요.
- regex 룰 테이블 유지 비용. 새 런타임·프레임워크 추가 시 갱신 필요.
- LLM judge 일관성 — 같은 로그에 다른 판정을 내릴 수 있음. 프롬프트 고정 + 몇 개 시드 예시 포함.

## 연관 구현

**현재 상태 (Phase 6 MVP, PR #5)**

- `orchestrator/src/envs/failure-classifier.service.ts`
  - `FailureKind`: `infra_error | env_rejected | transient | code_bug | unknown` (5종)
  - `RULES` 테이블 — 우선순위: infra_error → env_rejected → transient → code_bug. 복수 매칭 시 "뒤쪽(실제 실패 라인) 우선".
  - `infra_error` 패턴 7종: claude-auth-failed, claude-cli-not-found, claude-rate-limit, claude-context-overflow, disk-full(ENOSPC), oom(JavaScript heap out of memory 등), docker-daemon
- `orchestrator/src/envs/env-deploy.service.ts` — **env_qa 실패**에 classifier 적용. mode(fresh/maintenance) + kind 조합으로 전이 결정.
- `orchestrator/src/agents/building.runner.ts` **(2026-04-20 추가)** — **build phase 실패 (exit code 2)**에도 classifier 적용.
  - `bounceGaps: Map<string, string[]>`로 빌드 중 error/phase_end의 gap_list 누적
  - handleExit에서 gap_list + build_phases.output_log를 합쳐 classifier에 투입
  - **`infra_error` → `state=failed` + 운영자 메시지** (기획 반송 X). 이전엔 전부 planning으로 보내 유저를 헷갈리게 했음.
  - `transient` → `state=failed` + "잠시 뒤 재시도" 안내
  - `code_bug` / `unknown` → 기존 planning 반송 유지
- `orchestrator/src/projects/entities/project.entity.ts` — `env_attempts` INTEGER 컬럼.
- `orchestrator/src/projects/projects.service.ts` **(2026-04-20 추가)** — `findOne`이 `last_bounce: {build_id, finished_at, gap_list}` 필드 반환. planning/plan_ready로 돌아온 직후 프론트 배너에서 "왜 돌아왔는지" 즉시 보이게.
- `orchestrator/src/builds/builds.service.ts` — `closeBuild(id, 'bounced', gaps)`가 이제 항상 gaps를 받음. `bounce_reason_gap_list` 컬럼에 영속화.
- `orchestrator/src/infra/docker.service.ts` — `getLogs(containerId, tailLines)` (Docker 멀티플렉스 프레임 헤더 파싱 포함).
- WebSocket `error` 이벤트 payload에 `classifier / matched_rule / reason_snippet / next_state / gap_list` 전달.
- 프론트
  - `EnvInput.tsx` — `FailureBanner` (kind별 톤·카피·행동 분기, 세부 내용 토글)
  - `Chat.tsx` **(2026-04-20 추가)** — `last_bounce` 배너 (주황 톤, planning/plan_ready 상태 + bounced 빌드 최근 발생 시)

**아직 안 한 것**

- **LLM judge 2차** — regex 룰이 커버 못 하는 로그가 쌓이면 Phase 6.1에서 도입.
- **`build_phases.failure_kind` 컬럼** — 현재는 agent_logs payload에만 남음. 통계가 쌓이면 승격.
- **자동 재시도** — `infra_error`가 일시적일 수 있는 경우(claude 토큰 일시 만료 등) 운영자 개입 전 1~2회 자동 retry. 현재는 즉시 failed.
