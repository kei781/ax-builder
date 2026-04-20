# ax-builder 아키텍처

> Status: accepted · 2026-04-15
> 이 문서는 ax-builder의 시스템 구조·책임 분리·상태 머신·계약(contract)을 정의한다.
> 제품 사양(무엇을 만드는가)은 `PRD.md`에, 디자인 시스템은 `DESIGN.md`에 있다.
> 이 문서는 **어떻게 만드는가**만 다룬다.

---

## 1. 배경과 문제의식

현 구조는 "Planning"과 "Building"이 비대칭으로 섞여 있다.

- 기획(PRD 생성·스코어링·대화)은 NestJS 안에 **프롬프트가 박힌 무상태 LLM 호출**로 구현되어 있다 (`scoring.service.ts`, `prd-generator.service.ts`). 사실상 에이전트가 아니다.
- 빌드만 진짜 에이전트(Hermes + Claude Code MCP)로 돌아간다.
- NestJS가 "서빙 + 기획 로직 + 빌드 오케스트레이션 + 권한 + UI"를 다 짊어지고 있다.

이 문서는 이 짬뽕을 **3-tier 책임 분리**로 재구성한다.

---

## 2. 3-tier 책임 분리

```
┌──────────────────────────────────────────────────────────────┐
│ NestJS Orchestrator                                           │
│  - UI 서빙 / 인증 / 권한 검증                                  │
│  - 프로젝트 상태 머신 소유 (§7)                                │
│  - 에이전트 프로세스 생명주기 관리 (spawn/timeout/cleanup)     │
│  - WebSocket 이벤트 허브                                       │
│  - DB 소유자 (Project / Conversation / Memory / Session / Env)│
│  - Env 파서·암호화·컨테이너 주입 (§19)                         │
│  - FailureClassifier — env_qa 실패 라우팅 (§11.2)              │
│  - AI Gateway 토큰 발급·주입 (§20)                             │
└──────┬──────────────────┬──────────────────┬─────────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌───────────────┐ ┌───────────────┐ ┌──────────────────────────┐
│ Planning      │ │ Building      │ │ AI Gateway               │
│ Agent (Py)    │ │ Agent (Py)    │ │ orchestrator 내장 (MVP)   │
│ 대화/PRD/DSN  │ │ PHASES/Claude │ │ /api/ai/v1/* OpenAI호환   │
│ 스트리밍       │ │ Code/QA 감독  │ │ Bearer auth / Gemini↑     │
└──────┬────────┘ └──────┬────────┘ └─────────▲────────────────┘
       │  LLM            │  LLM              │  LLM (생성 앱)
       └─────────────────┴───────────────────┤
                                             │
                               ┌─────────────┴────────────┐
                               │ 생성 앱 컨테이너(들)      │
                               │ AX_AI_TOKEN 주입 (§19)    │
                               └──────────────────────────┘
```

"Nest는 단순 서빙"이라는 표현은 쓰지 않는다. **Orchestrator**가 정확한 포지션이다. 플랫폼의 모든 LLM 트래픽은 **AI Gateway를 단일 경유**(§20) — 생성된 앱은 Anthropic/OpenAI/Gemini 키를 직접 보유하지 않는다.

---

## 3. Planning Agent

### 3.1 기술 스택
- **런타임**: 자체 구현. OpenAI 호환 API 추상화 레이어 위에서 동작.
- **현재 모델**: `gemini-3-flash-preview` (Gemini API).
- **전환 경로**: 로컬 Mac Studio 도입 시 `qwen3:32b` 또는 `gemma-4-31b`. `.env`의 slot 매핑만 교체.
- **모델 추상화**: [agent-model-mcp](https://github.com/kei781/agent-model-mcp)의 slot/backend/lifecycle 개념을 Python으로 포팅하여 `planning-agent/app/agent/llm/`에 내장.
  - **슬롯(역할)**: `chat` / `summarize` / `eval` / `tool_arg`
  - **백엔드**: `openai_compat` / `ollama` — `LLM_BACKEND` 환경변수 하나로 전환
  - **lifecycle**: idle timeout으로 로컬 모델 VRAM 자동 해제
- **Building Agent는 agent-model-mcp MCP 서버를 그대로 사용** (Hermes가 기존처럼 MCP tool call). 동일한 `.env`를 공유하여 slot 매핑 일관성 확보.
- **LangGraph/LlamaIndex/Claude Code 재활용은 채택하지 않음** — 로컬 모델 전환성 + 통제력을 우선.

### 3.2 프로세스 모델
- **long-lived 프로세스**. 대화 세션이 시작되면 프로젝트당 한 프로세스가 살아있다.
- **10분 유휴**: 상태 체크포인트를 DB에 저장 (크래시 복구용).
- **30분 유휴**: 프로세스 메모리에서 언로드. 다음 대화 시 DB에서 복원 후 재기동.
- **세션 ID는 빌드 완료까지 유지**. 언로드는 캐시 비움일 뿐, 세션 자체는 살아있다.

### 3.3 허용 도구
| 도구 | 허용 |
|---|---|
| `write_prd` | ✅ |
| `write_design` | ✅ |
| `ask_user` | ✅ |
| `search_memory` | ✅ |
| `update_memory` | ✅ |
| 웹 검색 / 외부 레퍼런스 | ❌ |
| 파일 시스템 기타 | ❌ |

### 3.4 스트리밍
- 토큰 단위 스트리밍 필수. Nest ↔ Planning Agent는 WebSocket.
- 도구 호출 중간 이벤트(`searching memory...`, `updating PRD section X...`) 중계.
- 취소 지원 (유저가 중간에 중단 가능).

### 3.5 Planning 결과물
- `PRD.md` (제품 사양, SSoT)
- `DESIGN.md` (UI/UX 사양, SSoT)
- `handoff.json` (구조화된 품질 메타데이터, §6)

`PHASES.md`는 Planning이 생성하지 않는다 — Building Agent의 Hermes 층이 생성한다.

---

## 4. Building Agent

Building은 **2-layer** 구조다.

### 4.1 Hermes 층 (감독)
- **모델**: Planning Agent와 동일한 agent-model-mcp slot 사용. 역할별 슬롯은 `phase_planner`는 `deep`, `qa_judge`는 `fast`.
- **역할**:
  1. PRD + DESIGN + handoff.json 읽기
  2. **PHASES.md 동적 생성** — 프로젝트 특성에 맞게 phase 분해 (Scaffold/Auth/Backend/Frontend/Integration/QA 등). 고정 템플릿이 아니라 PRD 내용 기반 생성.
  3. phase별 Claude Code 디스패치
  4. QA 실행·감독 (curl 테스트, 출력 검증)
  5. bounce-back 판단 (N회 수정해도 실패 시 Planning 반송)
- **리스크**: 동적 phase 생성 품질이 Gemini 3 Flash의 PRD 해석력에 의존. 로컬 모델 전환 시 특히 모니터링 필요. 품질 저하 감지 시 고정 템플릿 fallback 고려.

### 4.2 Claude Code 층 (실행)
- **호출 방식** (ADR 0009): **stream-json 프로토콜**. phase마다 `claude --print --input-format stream-json --output-format stream-json --permission-mode acceptEdits --verbose`로 spawn. Hermes는 stdin에 `{"type":"user","message":{"role":"user","content":"<phase prompt>"}}` 한 줄 쓰고, stdout에 오는 JSON 이벤트 스트림을 관찰. 최종 `{"type":"result","is_error":bool,"result":"..."}`가 종료 신호.
- **이유**:
  - 이전 `--print --output-format text` 방식은 warning/stderr가 stdout에 섞여 classifier 입력 오염 (회고 §6). stream-json은 이벤트 단위로 깔끔 분리.
  - tool use loop(Read/Write/Edit/Bash/Glob/Grep)는 Claude 내부에서 자율 수행 → Hermes는 **위임하는 상위 에이전트**로서 Claude Code를 자기 도구처럼 호출 (ADR 0009 "Hermes의 도구화" 비전).
  - LLM 호출은 Claude Code가 OAuth 구독 크레딧으로 처리 (`apiKeySource: "none"` 확인). 정액제 유지.
- **phase별 격리 세션**: 한 phase에 한 subprocess. 긴 컨텍스트 품질 저하·phase 간 오염 차단. 후속 최적화로 세션 재사용 가능하지만 MVP는 격리.
- **프롬프트 조립**: 각 phase 시작 시 다음을 주입:
  - `PRD.md` 전문
  - `DESIGN.md` 전문
  - `PHASES.md`에서 현재 phase 섹션
  - 이전 phase들의 요약 (완료 파일 경로 + 완료 상태)
  - 업데이트 라인이면 `UPDATE_MODE_RULES_SUFFIX` 추가 (ADR 0008)
- **권한**: `--permission-mode acceptEdits`로 Read/Write/Edit/NotebookEdit 자동 승인. Bash 승인은 별도 — 일부 `npm install` 같은 명령은 prompt에 의해 수동 스킵될 수 있음 (QA 단계에서 어차피 재실행).

### 4.3 프로세스 계층
```
NestJS ──spawn──> orchestrator.py (Hermes, Python)
                      │
                      └── for each phase in PHASES.md:
                            ├── spawn(claude --print --input-format stream-json
                            │         --output-format stream-json
                            │         --permission-mode acceptEdits)
                            ├── stdin ← user message (phase prompt)
                            ├── stdout 이벤트 스트림 관찰
                            │     · type=assistant (thinking, tool_use)
                            │     · type=user (tool_result)
                            │     · type=result (종료 — is_error / result text)
                            └── QA 실행 → 실패 시 동일 phase 재진입
```

### 4.4 반송(bounce-back) 정책
- 어느 phase든 **1회라도 실패**하면 Planning Agent로 자동 반송.
- 반송 시 Planning은 원래 세션 재개(§8), `handoff.json`에 실패 gap 리스트 추가.
- max retry 개념 없음 — 실패 = 즉시 반송.

---

## 5. 메모리 전략

### 5.1 스코프
- **프로젝트 단위**: 해당 프로젝트 대화·결정·용어·문서 변경 이력.
- **유저 단위(정적)**: 회원가입 폼/프로필 페이지에서 설정하는 속성. 예:
  - 개발자 여부 (개발자 / 비개발자)
  - 설명 깊이 선호 (간단 / 자세)
  - 기타 유저 프로필 필드
- **조직 단위: 채택하지 않음**.
- 유저 단위는 동적 학습이 아니라 **유저가 명시적으로 설정하는 정적 속성**. 대화 내용으로부터 암묵적 학습은 하지 않는다.

### 5.2 저장 구조
- **요약 + 원문**.
  - 원문: 모든 대화 턴을 DB에 그대로 저장.
  - 요약: 주기적으로 생성되어 DB에 누적. Planning Agent가 프롬프트 구성 시 "요약 + 최근 N턴 원문"을 사용.
- 벡터 임베딩·지식 그래프는 현 단계 미도입.

### 5.3 압축 타이밍
두 트리거의 OR + 세션 종료 배치:
1. **컨텍스트 N 토큰 도달** (비용 고려 절대 상한, 구체 값은 튜닝)
2. **50턴 초과**
3. **30분 미활동 시 배치 요약** (다음 재개 대비 요약본 미리 생성)

1M 토큰 컨텍스트를 물리적으로 다 쓰지 않는다 — 비용 통제가 우선.

### 5.4 크로스 세션 연속성
- 대화 중단 후 재개 시 **동일 세션 ID 되살리기**. 새 세션 생성하지 않음.
- 세션 ID는 빌드 완료 시점에만 종료(archived)된다.
- 빌드 성공 후 수정 요청은 **새 세션 ID**로 시작.

---

## 6. 핸드오프 계약

### 6.1 페이로드 스키마
```jsonc
{
  "prd_path": "/projects/{id}/PRD.md",
  "design_path": "/projects/{id}/DESIGN.md",

  "completeness": {                       // 0.0 ~ 1.0, 현재 스코어링 UI 5항목과 동일
    "problem_definition": 0.95,
    "feature_list":       0.90,
    "user_flow":          0.85,
    "feasibility":        0.90,
    "user_experience":    0.80
  },

  "unresolved_questions": [],             // 비어 있어야 핸드오프 가능
  "assumptions_made": [                   // 에이전트 임의 결정. 유저 검토용
    "기본 폰트는 Pretendard로 가정"
  ],
  "tech_constraints": {                   // Building이 벗어나면 안 되는 강제 제약
    "storage": "SQLite",
    "runtime": "Node.js + Express"
  },

  "schema_version": "1.0"
}
```

### 6.2 SSoT와 포맷
- **markdown이 SSoT**. json은 markdown 파싱 산출물.
- 둘 모두 프로젝트 디렉토리에 저장 → git 버저닝.
- 동기화 방식: 빌드 시작 전 markdown을 파싱해 json 재생성. 수동 편집 금지.

### 6.3 "완료" 판정 주체
1. Planning Agent가 self-completeness 평가 → "최소 조건 충족" 또는 "충분 조건 충족" 라벨 표시
2. 유저가 UI에서 **"빌드 시작"** 버튼 클릭 = 진짜 완료

즉 에이전트의 판단은 **제안**, 최종 결정은 **유저**.

### 6.4 기획 영역 vs 시스템 영역 구분
`PRD.md`의 각 섹션은 누가 채우는지 태그를 달아 관리:

- **유저 결정 영역 (`[user-required]`)**: 기획 의도, 달성 목표, 비즈니스 로직상 필수 플로우, 유저 플로우 (문과적 영역 일체). 모순이나 공백이 있으면 Planning Agent가 되물어야 함.
- **시스템 결정 영역 (`[ai-fillable]`)**: 데이터 모델, 포트, 인증 방식, 라이브러리 선택 등 개발자가 고르는 기술 결정. Planning/Building Agent가 `assumptions_made`에 적고 자동 결정.

유저는 비개발자를 기본 가정한다.

### 6.5 핸드오프 실행 프로세스 (planning → plan_ready)

```
[유저: 채팅 중 또는 "AI에게 핸드오프 요청" 버튼 클릭]
        │
        ▼
[프론트(Chat.tsx)]
  · 조건: project.state !== 'plan_ready' && readiness.can_build === true
  · 자동 메시지 전송: "기획이 충분히 정리됐습니다. propose_handoff
    도구를 호출해서 다음 단계(Building)로 이관을 제안해주세요."
        │
        ▼
[Orchestrator → Planning Agent WS]
        │
        ▼
[Planning Agent (Gemini tool-calling loop)]
  ├── (가드) write_prd 호출돼서 PRD.md 최신인지 확인
  ├── (선택) evaluate_readiness로 스코어 검증
  └── propose_handoff 호출 ← **이게 진짜 전이 트리거**
        │
        ▼
[propose_handoff.py]
  1. 검증: completeness 5개 모두 ≥ 0.6, unresolved_questions 비어있음
  2. INSERT handoffs 행 (handoff_id 발급)
  3. 전이 분기 (ADR 0008):
     - current_state == 'planning'        → plan_ready
     - current_state == 'planning_update' → update_ready
     - 그 외                               → 전이 X (tool은 accepted=true지만
                                            transitioned=false)
  4. 반환: { ok, accepted, transitioned, transition_target, handoff_id, ... }
        │
        ▼
[Orchestrator (ChatService.handleAgentEvent)]
  · tool_result 수신 → transitioned_to_plan_ready===true면
    WS 이벤트 `progress(phase='plan_ready', detail='빌드 준비 완료')` 방출
        │
        ▼
[프론트(Chat.tsx)]
  · handoffBanner 표시 + project refetch → state='plan_ready'
  · "AI에게 핸드오프 요청" 버튼이 "빌드 시작"으로 바뀜
```

### 6.6 잘 알려진 실패 모드와 대응

| 증상 | 원인 | 대응 |
|---|---|---|
| UI 배너 사라지지 않음 / "이관 완료" 텍스트 후에도 state=planning 유지 | **AI가 propose_handoff를 실제로 호출하지 않고 텍스트로만 "완료"라고 환각** (evaluate_readiness 스코어와 이전 handoff 기억을 섞어버림) | ① 시스템 프롬프트에 "텍스트로 '이관 완료' 선언 금지, 반드시 propose_handoff 호출 후 결과만 보고" 명시 (§3 system_prompt.py). ② 프론트: tool_result에서 propose_handoff `transitioned_to_plan_ready` 플래그가 10초 내 도착하지 않으면 "AI가 도구를 호출하지 않은 것 같아요. 다시 요청해주세요" 토스트. |
| bounce-back 후 handoff 배너가 그대로 있음 | 이전 handoff 행은 DB에 남아있고 `can_build`는 그 행을 그대로 읽기 때문 | 기대 동작. state=`planning`이 되돌아갔으므로 유저가 다시 "핸드오프 요청" → Planning Agent가 **새 propose_handoff 호출** → 새 handoff 행 삽입 + state 전이. (기존 행을 invalidate하지는 않음 — 이력 보존) |
| propose_handoff가 `accepted=false`로 반환 | completeness 중 하나가 0.6 미만, 또는 `unresolved_questions`가 비어있지 않음 | Planning Agent가 계속 대화로 보강. 반환값의 `reason` 필드를 프론트에 "핸드오프 보류" 배너로 노출. |
| UPDATE rowcount=0 (state가 이미 plan_ready) | 동시 두 번 호출 등의 레이스 | tool은 무해하게 `transitioned_to_plan_ready: false` 반환. 프론트는 state API refetch로 정합. |

---

## 7. 프로젝트 상태 머신 (ADR 0005 mock-first + ADR 0008 update line)

### 7.1 상태 목록 (두 라인 + env 사이드)

**첫 빌드 라인** (신규 프로젝트)
```
draft → planning → plan_ready → building → qa → deployed ←──────┐
          ↑                                      ↕ self-loop     │
          │                                   (env 저장, 재시작 無)│
          │                                      ▼                │
          │                                   env_qa              │
          │                               ┌──────┼──────────┐     │
          │                           success / transient /       │
          │                           env_rejected                 │
          │                                      │ (모두 deployed 유지)│
          │                                      ▼                 │
          │                                 code_bug / schema_bug  │
          │                                      ▼                 │
          │                              planning_update / planning│
          │                                                        │
          └──── phase 실행 실패(구조 버그) ──────── planning bounce ┘
```

**업데이트 라인** (배포된 앱의 수정, ADR 0008)
```
deployed → planning_update → update_ready → updating → update_qa ──┐
    ▲              ▲                             ▼           ▼     │
    │              │           rollback (previous 복구, deployed 유지)│
    │              │                             │                  │
    │              └──── bounce (code_bug / schema_bug /             │
    │                            regression_fail) ──────────────────┘
    │
    └── update_qa 통과 시 deployed (version+1, previous 필드 clear)
```

**핵심 불변식**
- **mock-first** (ADR 0005): 첫 빌드는 env 없이도 mock으로 deployed까지 직행.
- **update 실패 = 기존 배포 유지** (ADR 0008): `updating` / `update_qa` 실패는 `projects.previous_container_id`로 복구 + `deployed` 유지. 유저의 앱은 계속 동작. Planning 반송은 schema_bug 등 극단 케이스만.
- **modifying은 폐기** (ADR 0008): 사실상 `planning_update`로 리네임.

실패 분기는 전부 FailureClassifier(§11.2, ADR 0002)가 판정한다.

| 상태 | 라인 | 의미 |
|---|---|---|
| `draft` | 첫 빌드 | 프로젝트 생성 직후 |
| `planning` | 첫 빌드 | Planning Agent와 신규 대화 |
| `plan_ready` | 첫 빌드 | 완성도 충분, "빌드 시작" 대기 |
| `building` | 첫 빌드 | Building Agent phase 진행 |
| `qa` | 첫 빌드 | 관찰 기반 QA (mock 상태) |
| `awaiting_env` | env (레거시) | ADR 0005 이전 블로킹 플로우 호환 |
| `env_qa` | env | 재시작 헬스체크 진행 |
| `deployed` | 터미널·재진입 | 첫 빌드와 update 라인 공통 종착/출발 |
| `planning_update` | 업데이트 | 배포된 앱의 수정 아이디어를 Planning Agent와 논의 |
| `update_ready` | 업데이트 | 수정 사양 확정, "업데이트 시작" 대기 |
| `updating` | 업데이트 | 변경 범위 적용 중 (previous 백업 후 진입) |
| `update_qa` | 업데이트 | regression + 새 기능 검증 |
| `failed` | 터미널 | 해결 불가 (infra_error 등) |

### 7.2 전환 트리거

**첫 빌드 라인**
| 전환 | 트리거 |
|---|---|
| `draft → planning` | 유저 첫 메시지 |
| `planning → plan_ready` | `propose_handoff(from='planning')` |
| `plan_ready → building` | "빌드 시작" 클릭 |
| `building → qa` | Building Agent가 QA phase 진입 시 (중간 상태 — UI "검증 중" 배지 표시용) |
| `qa → env_qa` | QA 통과, 컨테이너 기동 단계로 |
| `env_qa → deployed` | 헬스체크 통과 |
| `building / qa → failed` | `code_bug` / `unknown` / `infra_error` / `transient` → retry-first (유저 선택 유도) |
| `building / qa → failed` | 유저 수동 중단(`POST /build/cancel`) |
| `failed → plan_ready` | `POST /build/retry` — 유효 handoff가 남아있으면 기획 수정 없이 재빌드 |

**env 사이드**
| 전환 | 트리거 |
|---|---|
| `deployed → deployed` | env 저장 (재시작 X) |
| `deployed → env_qa` | 저장 후 재시작 / `POST /restart` |
| `env_qa → deployed` | 헬스체크 통과 또는 transient/env_rejected 폴백 (현 배포 유지) |
| `env_qa → planning_update` | classifier `code_bug` |
| `env_qa → planning` | classifier `schema_bug` (극단) |
| `awaiting_env → env_qa` | (레거시) 초기 설정 제출 |

**업데이트 라인** (ADR 0008)
| 전환 | 트리거 |
|---|---|
| `deployed → planning_update` | 유저 배포 앱 채팅 첫 메시지 or "수정 요청" 클릭 |
| `planning_update → update_ready` | `propose_handoff(from='planning_update')` |
| `update_ready → updating` | "업데이트 시작" 클릭. `previous_container_id`/`previous_version` 백업. |
| `updating → update_qa` | 변경 범위 적용 완료 |
| `update_qa → deployed` (성공) | regression + 새 기능 통과, version+1 |
| `update_qa → deployed` (롤백) | classifier `infra_error` / `transient` → previous 복구 + 토스트 |
| `updating → planning_update` | classifier `code_bug` / `schema_bug` / `unknown` → 채팅 보강. previous 복구. |
| `update_qa → planning_update` | regression_fail → 깨진 엔드포인트 gap 첨부. previous 복구. |
| `updating → deployed` | classifier `infra_error` / `transient` → previous 유지, 토스트. |
| `qa / building → planning` | phase 실행 실패 (첫 빌드 라인 구조 bounce-back) |
| `update_qa / updating → planning_update` | phase 실행 실패 (업데이트 라인 구조 bounce-back) |
| `awaiting_env → env_qa` | (레거시) 초기 설정 모드에서 유저 제출 시 |

### 7.3 되감기
- `plan_ready` 상태는 중간 경유지. `building`에서 실패하면 `plan_ready`가 아니라 **`planning`으로 되돌린다** — "제작 가능"이라는 판단이 틀렸다는 의미이므로.
- 되감기 주체:
  - 기술 스택·포트 등 시스템 결정 영역의 미비 → 에이전트가 채움, 자동 재시도
  - 기획·플로우 등 유저 결정 영역의 미비 → 유저에게 질문으로 반송
- 해소 후 다시 `plan_ready` 진입.

### 7.4 버저닝
- 배포 성공할 때마다 git 커밋 + push.
- 각 버전은 **프로젝트 전용 private 저장소**에 별도 저장.
- 수정 실패 시 이전 성공 버전을 git에서 pull하여 재설정.
- 덮어쓰기 아니라 **누적 버저닝** (v1, v2, ...).

### 7.5 빌드 수명주기 복구

**중단 (`POST /build/cancel`)**
- `building` / `qa`: 유저가 진행 중인 빌드를 포기. state → `failed`, build row `cancelled`, 진행 중 phase `cancelled`. 자식 프로세스는 SIGTERM.
- `updating` / `update_qa`: `previous_container_id`가 있으면 state → `deployed` (이전 버전 유지), DB 복구. 없으면 `failed`.

**재시도 (`POST /build/retry`)**
- `failed` 상태 + `current_session_id`에 유효한 handoff(`isReadyForBuild`)가 남아있으면 **기획 수정 없이** 같은 handoff로 재빌드. state → `plan_ready` → `building` 원자 전이.
- 유효 handoff가 없으면 400 — 유저가 채팅으로 돌아가 `propose_handoff`를 다시 호출해야 함.
- 첫 빌드 라인 전용. 업데이트 라인 실패는 `planning_update` 반송 경로로 이미 해결 가능.

**고아 빌드 자동 정리 (orchestrator startup 훅)**
- `nest start --watch` hot-reload, pm2 재시작, SIGKILL 등으로 orchestrator가 재시작되면 자식 `building-agent` 프로세스를 잃어버리지만 DB엔 `running` state가 남는다 → UI가 영원히 "진행 중" 표시.
- `BuildingRunner.onModuleInit()`이 startup 시 2단계 sweep:
  1. **state 기반**: `building` / `qa` / `updating` / `update_qa` 상태 프로젝트 전수 검사. build `cancelled` + phase `cancelled` + project `failed`. 업데이트 라인이면 previous 복구, 첫 빌드 라인이면 `cleanupFailedContainer` (docker rm -f + port/container_id clear).
  2. **좀비 스위프**: `state='failed'`인데 `container_id IS NOT NULL`인 모든 row에 대해 `cleanupFailedContainer`. 과거 버그로 누적된 좀비를 재시작마다 한 번씩 쓸어냄 (회고 §7).
- 유저는 대시보드에서 한 번 클릭(`/build/retry`)으로 복구.

**빌드 실패 시 자동 컨테이너 정리 (회고 §7.5 후속)**
- `cleanupFailedContainer(projectId)` — projects.container_id가 있으면 `docker rm -f` + port/container_id `null`로 clear.
- 호출 지점: `handleExit`의 첫 빌드 라인 `infra_error` / `transient` / `code_bug` / `unknown` / unrecoverable 분기, `cancel()`의 rollback 불가 경로.
- 업데이트 라인은 호출 **안 함** — previous 컨테이너가 살아있어야 한다는 ADR 0008 §D4 불변식 때문. 업데이트 쪽은 `rollbackToPrevious()`가 별도로 DB를 previous로 되돌림.
- 예방이 탐지보다 싸다: port-allocator의 좀비 방어 쿼리도 있지만, 좀비가 생기지 않는 게 최선.

### 7.5.1 포트 할당·QA 격리 (회고 §7)

**port-allocator 점유 판정**:
- DB 기준으로 `container_id IS NOT NULL OR port IS NOT NULL` 전체 row를 점유로 간주 (state에 의존하지 않음 — `failed` 상태라도 좀비 컨테이너가 있을 수 있음).
- **블랙리스트**: 3000/3001/5000/5173/5174/8000/8080 같은 "앱이 흔히 하드코딩하는 포트"와 플랫폼 예약 포트(4000 orchestrator, 4100 planning-agent)는 배포 호스트 포트로 할당 안 함. 할당 순간 비어 있어도 QA가 호스트 Node 프로세스로 띄울 때 충돌 유발.
- **OS 레벨 bind 체크**: DB와 블랙리스트 통과 후에도 `net.createServer().listen(port)` 테스트로 실제 바인드 가능한지 최종 확인. 외부 프로세스·좀비가 점유 중이면 skip.

**QA 포트 격리** (`qa_supervisor.py`):
- OS에 빈 포트를 받아 `PORT` env로 주입. 앱이 `process.env.PORT` 존중하면 다른 프로젝트와 포트 격리.
- 앱이 하드코딩해 다른 포트에 바인드하면 기존 관찰 방식(`_gather_listen_ports`)으로 폴백. 단 하드코딩 포트가 이미 점유 중(EADDRINUSE)이면 로그에서 감지해 "앱이 PORT env 무시 + 하드코딩 포트 점유 충돌" 메시지를 `gap_list`로 노출.

**앱 측 규약 (phase_runner.py 프롬프트)**:
- Claude Code가 생성하는 모든 앱은 `const PORT = process.env.PORT || 기본값; app.listen(PORT)` 패턴 필수. 하드코딩 금지. 병렬 기동·배포 공존을 위한 전제.

### 7.6 실패 라우팅 정책 — retry-first (첫 빌드 라인)

**배경**: Claude Code가 같은 PRD로 같은 phase를 실행해도 결과가 확률적으로 달라진다. npm install의 네트워크 flakiness, LLM 응답 변동, 일시적 파일시스템 경합 등이 섞임. 이전 정책(`code_bug` → 즉시 planning 반송)은 **PRD가 문제 없는데도 유저를 매번 기획 대화로 돌려보내는** 오작동이 잦았다 (실제 사례: PRD를 전혀 안 고치고 `propose_handoff`만 다시 호출해도 빌드가 통과).

**변경**: 첫 빌드 라인의 `code_bug` / `unknown` / `infra_error` / `transient` 모두 **`failed`로 수렴**시킨다. 유저가 BuildStatus 화면에서 두 CTA 중 선택:

- **`[↻ 다시 빌드]`** (primary, 기본값) — `POST /build/retry` → `failed → plan_ready → building`. 같은 handoff로 재시작.
- **`[기획 대화로]`** (secondary) — chat으로 이동해 PRD 보강 후 `propose_handoff` 다시.

**연속 실패 플립**: `builds.getConsecutiveFailureCount()`로 최근 성공 빌드 이후 실패 개수를 센다. **2회 이상**이면 UI가 primary/secondary를 뒤집어 "기획 대화로"를 기본값으로 노출. 같은 기획으로 반복 실패 = 재시도보다 대화 보강이 효과적이라는 휴리스틱.

**업데이트 라인 예외**: `updating` / `update_qa`의 `code_bug`는 여전히 `planning_update`로 반송(+previous 복구). 업데이트는 배포 버전이 살아있고 대화로 수정하는 흐름이 자연스럽기 때문 (ADR 0008 §D3 분리 원칙).

---

## 8. 대화 인터랙션 모델

### 8.1 턴 구조
- 동기 turn-by-turn + **비동기 agent-initiated** 허용.
- Planning Agent가 백그라운드 분석 후 먼저 질문을 던질 수 있다 (예: PRD 분석 후 "이 부분이 모호합니다, 확인 필요").

### 8.2 편집·분기 정책
- 유저의 이전 메시지 수정·삭제: **불가**.
- 대화 분기(branching): **불가** (맥락 훼손 방지).
- **마지막 에이전트 응답 재요청 1회**: 허용. UI 버튼으로 제공.

### 8.3 동시 대화
- 프로젝트 하나에 여러 유저(owner + invited)가 동시 접속 가능.
- 유저가 메시지를 보내면 **에이전트 응답이 도착할 때까지 모든 유저에게 입력 잠금**.
- 한 번에 한 턴씩 진행.

### 8.4 대화 세션 종료
- 에이전트가 "문서 완성" 선언 + 유저가 "빌드 시작" 클릭 → `plan_ready → building`.
- 빌드 반려 시 대화 재개 (세션 유지).
- **진짜 세션 종료 = 빌드 완료 성공 시점**.

---

## 9. 권한 모델

### 9.1 역할
- `owner`: 프로젝트 생성자
- `invited` (= editor): owner가 초대, 또는 요청 승인된 유저
- `viewer`: 로그인한 모든 유저

### 9.2 권한 매트릭스
| 행위 | viewer | invited | owner |
|---|---|---|---|
| 프로젝트 목록 조회 | ✅ | ✅ | ✅ |
| 배포된 앱 접속 | ✅ | ✅ | ✅ |
| PRD/대화 읽기 | ✅ | ✅ | ✅ |
| PRD/대화 쓰기 | ❌ | ✅ | ✅ |
| 재빌드/수정 | ❌ | ✅ | ✅ |
| 프로젝트 삭제 | ❌ | ❌ | ✅ |
| 멤버 초대/승인 | ❌ | ❌ | ✅ |

### 9.3 초대 메커니즘
- **서비스 가입**: 이메일 기반 (기존).
- **프로젝트 멤버십**:
  - (a) **권한 요청**: 초대받지 못한 유저가 프로젝트에 "참여 요청" → owner 승인
  - (b) **권한 초대**: owner가 특정 유저에게 "초대" → 유저 승인

둘 다 양방향 승인 필수.

### 9.4 에이전트 컨텍스트
- Planning Agent는 **프로젝트 단위로만** 동작. 누가 말했는지 구분하지 않음.
- UI상 메시지에 유저명 표기는 순수하게 사용자 편의용. 에이전트는 이를 참조하지 않음.

### 9.5 플랫폼 관리자 (admin)

운영·디버깅·사용자 지원을 위해 `users.is_admin` 플래그가 있다. admin은 모든 프로젝트에 대해 **owner 권한으로 접근**한다:
- 채팅 읽기/쓰기, 빌드 시작·중단·재시도, env 편집, 프로젝트 삭제
- `/projects` 목록 조회 시 전체 프로젝트가 내려옴 (`myRole='owner'`)
- `ProjectPermissionsGuard`와 `ChatService.requireMembership`는 admin이면 권한 체크를 bypass
- 실제 `project_permissions` 행은 만들지 않음 — 가상 owner 역할

**부여 방식**: 환경변수 `ADMIN_EMAILS`(쉼표·세미콜론·공백 구분) 리스트의 이메일로 OAuth 로그인하는 유저는 자동으로 `is_admin=true`. 이미 가입된 유저도 orchestrator startup 시 `AuthService.onModuleInit()`이 DB에 반영. 한 번 부여된 권한은 env에서 이메일을 빼도 **코드가 자동 회수하지 않는다** (운영 실수로 관리자 권한 박탈되는 상황 방지 — 해지는 DB 수동 UPDATE).

**JWT 전파**: `is_admin` 플래그는 JWT payload에 포함되어 Guard·Service가 DB 조회 없이 O(1) 확인. 다만 환경변수 변경 직후 승급은 **다음 로그인**에서 새 토큰으로 반영됨.

**감사(audit)**: admin이 다른 유저 프로젝트에 수행한 모든 에이전트 호출은 기존 `agent_logs`에 project_id 단위로 기록되며, chat 메시지의 `author_user_id`로 "누가 썼는지"가 남는다. 즉 admin 접근은 투명하게 추적 가능.

---

## 10. 동시성·자원 정책

### 10.1 한계
| 항목 | 한계 |
|---|---|
| 유저당 동시 planning 세션 | 2개 |
| 유저당 동시 building | 1개 |
| 시스템 전체 동시 building | **3개** (초기값, API rate limit + CPU 기준) |
| 프로젝트 하나당 동시 대화 세션 | 무제한 (lock으로 직렬화) |

### 10.2 큐잉
- 한계 초과 시 큐잉. 즉시 거부 아님.
- 우선순위: 유료 유저 우선, 무료 유저 후순위.
- 현 시점에선 유료 티어를 구현하지 않음 — 미래 대비 스키마만 둠.

### 10.3 타임아웃
- **Planning 세션**: 30분 유휴 → 저장 + 메모리 언로드.
- **Building**: 하드 월클락 타임아웃 없음. 대신 **5분간 phase 진행·응답 없으면** 타임아웃 (hang 감지).
- **배포된 컨테이너**: 마지막 접근 + 1일 후 메모리 언로드. 재접속 시 cold start 허용. 유휴 시간은 프로젝트별 설정 가능.

---

## 11. 실패·재시도 정책

### 11.1 Planning 실패
- 에이전트 오류 → 자동 재시도 후 유저에게 노출.
- **무의미 입력 반복** (예: "ㅎㅇ"만 계속 입력):
  - 탐지 로직: 동일/의미 없는 입력 N회 연속 감지 시 lock.
  - lock 효과: 프로젝트 **24시간 잠금**. 이 lock은 유저당 planning 세션 한도(2개)에 계속 카운트됨.
  - 해제 조건: 유저가 프로젝트 삭제 **또는** 24시간 경과.

### 11.2 Building / QA 실패 — FailureClassifier (ADR 0002)

> 이전 정책 "어느 phase든 1회 실패 = 즉시 Planning 반송"은 **phase 실행 실패**에 한정해서 유지. QA/env_qa 단계 실패는 classifier가 책임 주체로 쪼개서 라우팅한다.

**phase 실행 실패 (code 생성 phase)**
- max retry 없음 → 즉시 Planning 반송.
- 부분 성공도 "문서 부족"으로 간주. 동일 정책.
- 구조화된 gap 리스트를 Planning에 전달.

**QA / env_qa 단계 실패 → classifier 4분류 (ADR 0005 반영)**

| kind | 시그니처 예 | 전이 (env_qa 시점) | 카운터 |
|---|---|---|---|
| `env_rejected` | 401/403, Unauthorized, Invalid API key | **`deployed` 유지 + 에러 토스트** (롤백 = 이전 컨테이너 살아있음) | `env_attempts++`; ≥3이면 `schema_bug`로 에스컬레이트 |
| `transient` | ECONNREFUSED/ETIMEDOUT/ENOTFOUND, 502/503 | **`deployed` 유지 + "잠시 뒤 다시 시도"** 토스트 | 비카운트 |
| `code_bug` | SyntaxError/TypeError/MODULE_NOT_FOUND | `modifying` (대화로 수정) | — |
| `schema_bug` | env 반복 거부 3회 | `planning` (기획 재검토, 극단 케이스) | env_attempts 리셋 |
| `unknown` | 위 규칙 미매칭 | `code_bug`로 폴백 → `modifying` | — |

**중요한 차이**: ADR 0005 이전엔 실패 시 `awaiting_env`로 **되돌아가는 블로킹** 동작이었지만, mock-first에선 이전 배포가 이미 돌고 있으므로 **`deployed` 유지가 기본**. 유저는 토스트로 원인을 보고 값을 다시 입력하거나 대화로 수정한다.

구현은 1차 regex 룰 + (TODO) 2차 `qa_judge` LLM. 상세 규칙은 `orchestrator/src/envs/failure-classifier.service.ts` 및 ADR 0002 참조.

### 11.3 수정 실패
- git에 저장된 직전 성공 버전을 pull하여 복원.
- 롤백은 git 기반 자동.

---

## 12. 에이전트 제어 프로토콜

### 12.1 Nest ↔ Planning Agent
- **WebSocket** (양방향, 스트리밍).
- 이벤트 타입: `user_message`, `agent_token`, `tool_call`, `tool_result`, `completion`, `user_prompt`(agent-initiated).

### 12.2 Nest ↔ Building Agent
- **단기**: 현행 `spawn(python orchestrator.py)` + stderr JSON lines 유지.
- **중기**: HTTP 서비스로 승격 (PM2 또는 Docker 관리). 오펀 프로세스·재시작·헬스체크 확보.
- Building Agent 내부에서 다시 `spawn(claude-cli ...)` for each phase.

### 12.3 진행 이벤트 스키마 (통일)
```jsonc
{
  "agent": "planning" | "building",
  "project_id": "...",
  "event_type": "progress" | "log" | "error" | "user_prompt" | "phase_start" | "phase_end",
  "phase": "...",
  "progress_percent": 0,
  "payload": { /* event-specific */ }
}
```
기존 Building의 `{phase, current_task, progress_percent}`는 `payload`로 이동.

### 12.4 취소·일시정지
- **취소**: 지원. 유저가 Building 중 "중단" 가능. 중단 시 상태 = `failed`, 진행 중 파일 보존.
- **일시정지**: 미지원. Claude Code 재개 시 오작동 리스크 및 효용 낮음.

---

## 13. 관찰성·감사

### 13.1 로그
- **프롬프트/응답 원문 전부 저장**. DB는 별도 미니 PC에 4TB, 용량 제약 없음.
- 로깅·디버깅 우선, 프라이버시보다 우선순위 높음 (사내 도구).
- 도구 호출 이력도 원문 저장.

### 13.2 비용 추적
- 프로젝트별 LLM 토큰 소비 기록.
- 유저별 상한은 유저당 동시 세션 한도(G1)로 자연 수렴 (planning 2 + building 1 = 3). 시스템 전체 한도(3)는 실시간 GPU/CPU 사용률 보고 조정.
- 현 단계에서는 Claude Code 정액제 한도가 자연 상한 역할. 별도 토큰 cap 미구현.

### 13.3 리플레이·디버깅
- **Planning**: 대화 원문 + 최종 산출물(PRD/DESIGN/handoff)만 보존. 세션 완벽 재현은 불필요.
- **Building**: 실패 시 "어느 phase에서 왜 실패했는지"가 중요 → phase별 로그·Claude Code 응답·QA 결과를 보존.

---

## 14. 운영·비용

### 14.1 API 키
- **시스템 공용 키**. BYOK 미지원.
- 사내 사용 + 로컬 모델 전환 계획 고려.
- 로컬 모델 전환 후엔 "키" 개념 자체 소멸 → 컴퓨팅 자원 분배 문제로 전환.

### 14.2 무한 대화 방지
- 완성된 PRD(900점 도달) 상태에서 추가 대화 시작하려 하면 경고:
  > 이미 완성된 문서입니다. 추가 기능을 요청하시겠습니까? 스코어 점수가 떨어져 빌드를 못 하게 될 수도 있습니다. (예/아니오)
- 비용 폭주는 Claude 정액제 한도로 자연 제한.

### 14.3 컨테이너 수명
- 마지막 접근 + 1일 후 suspend.
- 재접속 시 cold start 허용.
- 유휴 시간은 프로젝트별 설정 가능.

---

## 15. 남긴 리스크와 후속 과제

1. **동적 PHASES.md 생성 품질 의존성** — Gemini 3 Flash / 로컬 모델의 PRD 해석력이 Building 품질을 좌우. 품질 저하 감지 시 고정 템플릿 fallback 구현 필요.
2. **Building Agent spawn 모델의 오펀 프로세스 리스크** — 중기에 HTTP 서비스로 승격 예정. 그 전까지는 pid 저장 + shutdown hook으로 완화.
3. **멀티 유저 동시 대화의 잠금 체감** — 잠금이 길어지면 UX 저하. 실측 후 lock 해제 조건 조정 필요.
4. **유저 단위 메모리의 스코프 경계** — 정적 속성만 수용하되, 향후 "이 유저 프로젝트 전반에서 반복되는 패턴" 자동 학습 요구 발생 시 별도 논의 필요.
5. **로컬 모델 전환 시 GPU 동시 실행 수 제약** — 128GB 통합 메모리 기준 qwen3:32b int4 동시 6~7개가 한계. 시스템 동시 building 3개 + planning 활성 N개가 이 한도를 넘지 않는지 실측 필요.
6. **bounce-back 무한 루프 가능성** — Building 실패 → Planning 반송 → 유저가 같은 PRD 제출 → 같은 실패. 동일 gap이 K회 반복 반송되면 강제 중단 + 유저에게 에스컬레이션 필요.
7. **slot 매핑 오설정 리스크** — `.env`의 slot 모델이 해당 역할에 부적합(예: `SLOT_CHAT=gemma-1b` 같은 과소 모델)하면 에이전트 품질이 급락. 운영 가이드에 slot별 최소 권장 체급 문서화 필요.
8. **3-서비스 독립 분리** — 현재 모노레포(`orchestrator/`, `planning-agent/`, `building-agent/`)가 `.env`와 SQLite를 공유하여 서비스 경계가 흐릿함. 안정화 후 다음 마일스톤에서:
   - Planning Agent: SQLite 직접 접근 제거 → orchestrator API를 통해서만 데이터 접근
   - Building Agent: subprocess spawn → 독립 HTTP 서비스로 승격
   - 공유 `.env` → 서비스별 config 분리, 서비스 간 통신은 API 계약으로
   - 이를 통해 각 서비스의 권한·책임·배포 독립성 확보

---

## 16. 채택하지 않은 대안들

간단히만 기록한다 (왜 안 했는지 나중에 다시 논의될 때 참조용).

- **Planning Agent를 LangGraph/LlamaIndex로 구축**: 로컬 모델 전환성 + 프레임워크 락인 회피.
- **Planning Agent를 Claude Code 서브에이전트로 재활용**: Claude 모델에 묶여 로컬 전환 불가.
- **PHASES.md 고정 템플릿**: 프로젝트별 특성 반영 불가. 초기 구현 단순성보다 유연성 우선.
- **Claude Code 세션 지속(`claude --resume`)**: phase 간 컨텍스트 오염 리스크가 이점보다 큼.
- **Planning이 PHASES.md도 생성**: 수동 워크플로우에서도 "PRD는 Claude chat, phase는 Claude chat, 실행은 Claude Code"였지만, 자동화 시엔 "PRD 생성"과 "phase 설계"는 관심사가 다름 (기획 vs 엔지니어링). Hermes 층으로 이관.
- **벡터 임베딩 기반 메모리**: 초기엔 요약+원문으로 충분. 유저 단위 메모리가 커지면 재검토.
- **BYOK**: 사내 도구 + 로컬 전환 로드맵 고려 시 불필요.
- **max 3회 Building 재시도**: 실패 = 문서 부족 → 유저에게 물어야 함. 기계적 재시도로 해결되지 않음.
- **Planning Agent의 웹 검색 도구**: 품질 통제 어렵고, 본래 역할(유저 대화로 PRD 구축)과 방향성이 다름.

---

## 17. 용어 정리

- **SSoT (Single Source of Truth)**: PRD.md와 DESIGN.md. 다른 파일은 여기서 파생.
- **handoff**: Planning → Building으로 제어권을 넘기는 행위.
- **bounce-back**: Building → Planning으로 되돌리는 행위 (구현 불가 판단 시).
- **phase**: Building이 코드를 만들어내는 단위. PHASES.md에 순서대로 기재.
- **session**: 한 프로젝트의 대화·빌드 전체 생명주기 단위. 빌드 완료 전까지 유지.
- **lock (프로젝트)**: 무의미 입력 반복 등으로 일시 사용 제한된 상태. 유저의 planning 세션 한도에서 차감됨.

---

## 18. 운영 중 발견한 버그와 해결 패턴

> 같은 실수 반복 방지용 기록. 새 기능 추가 시 먼저 이 목록을 훑어볼 것.

### 18.1 Gemini OpenAI-compat 엔드포인트의 특이 동작

1. **tools + 짧거나 모호한 입력 → 빈 응답**
   - 증상: `{text: "", tool_calls: []}` 반환, finish_reason=stop
   - 예: "ㄱㄱ" 같은 짧은 한국어 답변
   - 해결: `loop.py`에서 빈 응답 시 **tools 제거하고 재시도**하는 fallback
   - 위치: `planning-agent/app/agent/loop.py` `run_turn()` 말단

2. **finish_reason="stop" + tool_calls 동시 반환**
   - 증상: 도구 호출은 있는데 finish_reason이 `stop`이라 루프가 조기 종료
   - 해결: `tool_calls`가 있었으면 finish_reason 무시하고 다음 iteration 진행
   - 위치: `planning-agent/app/agent/loop.py` `finish_reason` 체크

3. **연속 동일 role 메시지 → 빈 응답**
   - 증상: `user → user → user` 연속되면 응답 안 함
   - 해결: `_build_initial_messages`에서 동일 role 연속 시 `\n`으로 병합
   - 위치: `planning-agent/app/agent/loop.py`

4. **JSON 예시가 포함된 프롬프트 + Python `.format()`**
   - 증상: `KeyError: '\n "name"'` 같은 포맷 에러
   - 원인: `{...}`가 format specifier로 해석됨
   - 해결: `f-string` 사용 또는 `{{}}` 이스케이프
   - 위치: `building-agent/phase_planner.py`

### 18.2 WebSocket 프로덕션 연결

1. **socket.io는 `/ws/`가 아니라 `/socket.io/` 경로 사용**
   - 증상: 프로덕션에서 "연결 중"이 지속, WS 안 붙음
   - 해결: Vite proxy에 `/socket.io` 프록시 룰 추가 (`/ws`는 네임스페이스지 HTTP 경로 아님)
   - 위치: `frontend/vite.config.ts`, `docker/nginx.conf`

2. **`transports: ['websocket']` 전용 → Cloudflare 등 프록시 환경에서 실패**
   - 해결: `transports: ['polling', 'websocket']`로 fallback 허용
   - 위치: `frontend/src/pages/Chat.tsx`, `BuildStatus.tsx`

### 18.3 상태 지속성 (새로고침 대응)

**대원칙**: WS 이벤트만 의존하면 새로고침 시 UI가 리셋됨. 반드시 **API로 초기 로드 + WS로 실시간 갱신** 이중 구조로 할 것.

1. **스코어 사이드바 초기화**
   - 해결: `GET /chat/history`가 `readiness` 필드 반환
   - 우선순위: 최신 handoff → 최신 `evaluate_readiness` tool_result → null
   - 위치: `orchestrator/src/chat/chat.service.ts` `getHistory()`

2. **빌드 진행 상태 초기화**
   - 해결: `GET /build/status`가 phases 목록 반환
   - 위치: `orchestrator/src/agents/building.runner.ts` `status()`

3. **실패 사유 표시**
   - 해결: `GET /projects/:id`가 `failure_reason` 필드 반환
   - 위치: `orchestrator/src/projects/projects.service.ts` `findOne()`

### 18.4 Docker 배포

1. **이미지 없으면 `createContainer` 404**
   - 해결: `ensureImage()` 선제 pull
   - 위치: `orchestrator/src/infra/docker.service.ts`

2. **Docker 실패를 non-fatal로 삼키면 안 됨**
   - 증상: `container_id=NULL`인데 `state=deployed`로 전이, localhost 접속 불가
   - 해결: Docker 실패 → `build=failed, state=failed` + 프론트에 error 이벤트
   - 위치: `orchestrator/src/agents/building.runner.ts` `handleExit()`

### 18.5 NestJS 모듈 의존성

1. **순환 의존**
   - 증상: `UndefinedModuleException` at startup
   - 해결 우선순위:
     1. 가드/서비스가 Repo만 필요하면 `TypeOrmModule.forFeature([Entity])`로 Repo 직접 주입 (모듈 import 불필요)
     2. 공유 서비스는 중립 모듈(예: `InfraModule`)로 분리
     3. 최후의 수단: `forwardRef()`
   - 사례: `PermissionsGuard`가 `ProjectsService` 대신 `Repository<ProjectPermission>` 직접 주입

2. **자식 모듈이 주입받는 서비스는 export 필수**
   - `TypeOrmModule.forFeature([X])`로 Repo 쓰려면 같은 모듈 또는 부모에서 선언해야 함

### 18.6 DB 외래키

1. **프로젝트 삭제 시 CASCADE 없음 (SQLite)**
   - 증상: `SQLITE_CONSTRAINT_FOREIGNKEY`
   - 해결: 의존 테이블 FK-safe 순서로 명시적 삭제
     - `build_phases → builds`
     - `handoffs/conversation_messages/session_summaries → sessions`
     - `project_memory, project_versions, agent_logs, ProjectPermission`
     - 마지막에 `projects.current_session_id = NULL` → `Project` 삭제
   - 위치: `orchestrator/src/projects/projects.service.ts` `delete()`

2. **State machine 전이 누락**
   - 증상: 정상 플로우인데 `BadRequestException: Invalid transition`
   - 체크: `VALID_TRANSITIONS` 맵에 전이 추가됐는지
   - 사례: `building → deployed` (inline QA 통과 시) 추가

### 18.7 프로세스 생명주기

1. **Orchestrator 재시작 시 Building Agent subprocess 오펀**
   - 증상: DB는 `status=running`인데 실제 프로세스 없음, 빌드 영원히 대기
   - 해결 (임시): 관리자가 수동으로 DB state를 `failed`로, project state를 `plan_ready`로 복원
   - 해결 (근본): orchestrator shutdown hook에서 활성 빌드들을 failed 처리 (미구현)

2. **코드 변경 후 재시작 필수**
   - 빌드만 하고 프로세스 재시작 안 하면 구 빌드가 계속 동작
   - 체크리스트: orchestrator 코드 수정 → `npm run build && pkill dist/main.js && node dist/main.js`
   - Python 코드 수정 → uvicorn 재시작
   - Frontend 수정 → Vite는 HMR 자동, 프로덕션은 `npm run build` 필요

### 18.8 메시지 DB 저장

1. **빈 assistant 메시지 저장 금지**
   - 증상: DB에 빈 assistant row 생김 → 다음 턴에 연속 user 메시지 패턴 유발 (Gemini 빈 응답의 원인)
   - 해결: `ChatService.handleAgentEvent`에서 `content.trim().length > 0`일 때만 저장
   - 위치: `orchestrator/src/chat/chat.service.ts`

2. **Chat lock stale 방지**
   - 5분 이상 된 lock은 crash로 간주하고 auto-release
   - 위치: `orchestrator/src/chat/chat.service.ts` `sendUserMessage`


---

## 19. 환경 변수 lifecycle (mock-first, ADR 0005 + 0006)

PRD §9 / ADR 0004 / 0005 / 0006 의 런타임 계약.

### 19.1 배포 플로우 (env를 선행 조건이 아닌 점진적 향상으로)

```
[빌드 완료 (code 0)]
      │
      ▼
[orchestrator: EnvsService.syncFromExample(projectId)]
      │  ├── .env.example 파싱 (env-parser.ts)
      │  ├── provider-key 가드 (ANTHROPIC/OPENAI/GEMINI 등 user-tier 노출 금지)
      │  ├── mock/real 분기문 존재 여부 grep (ADR 0005) — 없으면 bounce-back
      │  └── project_env_vars upsert (기존 값 보존) +
      │      system-injected 값 주입 (AX_AI_* 등)
      │
      ▼
[EnvDeployService.applyAndDeploy]
      ├── writeDotenv — 현재까지 주입된 값(system만이어도 무방)으로 `.env` 기록
      ├── Docker 컨테이너 제거·재생성 (PORT=3000)
      ├── 호스트 HEAD 폴링 30초 — mock 상태로 정상 응답 확인
      └── 성공 → deployed (mock 상태 배너 UI)
```

ADR 0005 이전엔 `hasUserRequired()`가 true면 `awaiting_env`로 블로킹했지만, 이제 **user-required 변수와 무관하게 `deployed`로 직행**한다. 유저가 실제 값을 언제 넣을지는 선택.

### 19.2 유지보수 플로우 (ADR 0006 — deployed 이후 언제든)

```
[deployed 상태, 유저가 대시보드 "⚙ 환경 설정" 또는 "🔄 재시작" 클릭]
      │
      ├── "⚙ 환경 설정" → EnvInput 유지보수 모드
      │     ├── 필드별 편집 + 인라인 밸리데이션 (pattern/length)
      │     └── [💾 저장] → PUT /env { apply:false } → DB만 갱신
      │     └── [💾 저장 후 재시작] → PUT /env { apply:true } → 19.3
      │
      └── "🔄 재시작" → POST /restart → 19.3
```

### 19.3 재시작 경로 (env_qa) — recreate 기반

```
PUT /env { apply:true }  또는  POST /restart
      │
      ▼
[env_qa 진입]
      ├── envs.resolveAllForContainer(projectId) — 전 변수 복호화 → dict
      ├── writeDotenv (dev 편의·폴백용)
      ├── docker.removeContainer(container_id)  ← 이전 컨테이너 제거
      ├── docker.createContainer(... extraEnv=dict)  ← **새 env로 재생성**
      ├── docker.startContainer(newId)
      ├── 호스트 HEAD 폴링 60초
      └── ┌── 성공 → container_id 갱신 + deployed
          ├── transient / env_rejected / unknown → deployed 유지 + 토스트
          ├── code_bug → modifying (대화 수정 세션)
          └── schema_bug (극단) → planning bounce
```

**왜 restart가 아니라 recreate인가 (2026-04-20 반영)**: Docker의 `Env` 배열은 `createContainer` 시점에 고정되므로 `docker restart`로는 새 env가 반영되지 않는다. 유저가 ADMIN_PASSWORD를 "1111"로 설정해도 컨테이너가 예전 Env(또는 생성 시 주입한 기본값) 기반으로 계속 돌았다. **recreate 경로는 반드시 필요**.

**Docker Env 주입 경로**: `docker.service.createContainer`가 `extraEnv: Record<string, string>`을 받아 PORT/NODE_ENV 기본값과 합쳐 `Env` 배열 구성. 앱 프로세스가 `require('dotenv').config()` 호출 여부와 무관하게 `process.env`에서 읽음. `.env` 파일은 디버깅·개발 편의용으로 계속 생성(이중 공급).

**롤백 시맨틱 변경**: recreate 경로는 이전 컨테이너를 즉시 제거한다. 실패 시 "이전 컨테이너로 돌아가기"는 불가 — 하지만 실패해도 `.env`·소스·빌드 산출물은 디스크에 남아있으므로 **값을 되돌리고 다시 `/restart`** 하면 복구된다. state 자체는 classifier 결과에 따라 `deployed` 유지(서비스 중단 인상 최소화)·`modifying`·`planning`으로 분기.

### 19.4 system-injected 값 해석
`EnvsService.resolveSystemInjected`가 변수 이름 → 실제 값 매핑:

| 변수 | 소스 |
|---|---|
| `AX_AI_BASE_URL` | `AI_GATEWAY_BASE_URL` 플랫폼 env |
| `AX_AI_TOKEN` | `aiGateway.ensureToken(projectId)` — idempotent `axt_<48hex>` 발급, SHA-256 해시는 `projects.ai_token_hash`에 저장 (§20) |
| `AX_STORAGE_PATH` | 고정 `/app/data` |
| 그 외 | null (유저에게 노출되지 않음, 앱이 직접 처리) |

### 19.5 밸리데이션 (ADR 0006)

`.env.example`의 `# 패턴:` / `# 길이:` 메타라인을 파서가 추출 → `project_env_vars.validation_pattern` / `min_length` / `max_length` 컬럼에 저장. PUT `/env` 시 서버가 각 value에 대해 재검증, 실패 시 400 + `errors: [{key, reason, hint}]`. 프론트는 같은 로직으로 인라인 검증(blur/change).

### 19.6 암호화
- AES-256-GCM. 페이로드 = `IV(12) || AUTH_TAG(16) || CIPHERTEXT`, base64.
- 키 유도: `AX_ENV_ENCRYPTION_KEY`를 SHA-256으로 32바이트 파생.
- 미설정 시 `JWT_SECRET` 파생 dev 폴백 (기동 시 경고 로그). 운영 배포 전 전용 키 지정 권장.
- API 응답에서 원문은 **절대 반환하지 않음** — 마스킹 preview(`••••••5432`)만.

### 19.7 프론트엔드 제어
- `/projects/:id/env` 라우트 (`EnvInput.tsx`) — DESIGN.md §4, 2-모드 지원.
- 대시보드 카드: deployed 상태면 "⚙ 환경 설정" + "🔄 재시작"(owner만) 버튼 노출.
- mock 상태(user-required 중 값이 없는 행 존재) 배너: "⚠ mock 응답 중 — 실제 기능은 환경 설정 후 활성화".
- WS `agent_event`: env_qa 실패 시 `env_qa_failure` payload(classifier/matched_rule/…)로 `FailureBanner` 노출.

---

## 20. AI Gateway

PRD §9.0 / §18 / ADR 0003의 구조 계약. 현재 **orchestrator 내장** 구현(Phase 6 MVP). `github.com/kei781/agent-model-mcp`는 Phase 6.1에서 backend로 통합 예정.

### 20.1 위치
플랫폼·에이전트·생성 앱의 **모든 LLM 호출** 단일 경유 레이어. 원본 provider 키(Anthropic/OpenAI/Gemini)는 게이트웨이 서버(= orchestrator host)에만 존재한다. 생성 앱 컨테이너는 `AX_AI_TOKEN`(프로젝트별 Bearer)만 보유.

### 20.2 MVP 인터페이스 (현재)
- **OpenAI 호환 HTTP** — `POST /api/ai/v1/chat/completions` (SSE 통과), `POST /api/ai/v1/models`. 생성 앱은 `openai` SDK `baseURL` 한 줄 바꿔 호출.
- **upstream**: Gemini OpenAI-compat (`generativelanguage.googleapis.com/v1beta/openai`). 모델 정규화:
  - `default` / `cheap` / `fast` → `gemini-2.5-flash`
  - `reasoning` → `gemini-2.5-pro`
  - 모르는 이름은 pass-through
- **토큰**: `axt_<48hex>` 평문은 `project_env_vars.AX_AI_TOKEN`(AES-GCM 암호화), SHA-256 해시는 `projects.ai_token_hash`(indexed). Bearer 검증은 O(1) 역조회.

### 20.3 Phase 6.1 확장 인터페이스 (예정)
- **OpenAI 호환 추가** — `POST /embeddings`
- **passthrough** — `POST /api/ai/v1/anthropic/messages` (tool use/thinking/caching), `POST /api/ai/v1/gemini/{model}:generateContent`
- **MCP** (Streamable HTTP 또는 stdio) — `generate` / `complete_stream` / `embed` / `list_models` / `usage_today` 툴. Planning/Hermes가 직접 소비 (개별 HTTP 대신 MCP).
- **admin API** (`/admin/tokens`, `/admin/usage`, `/admin/models`) — 프로젝트 토큰 수동 발급·폐기, 사용량 조회, 모델 매핑 관리.

### 20.4 인증·통제
- **MVP**: 해시 기반 Bearer 인증만. 모든 유효 토큰 = 전 모델 허용, 한도 없음.
- **Phase 6.1**: 토큰별 일일/월 cap, RPS 제한, 모델 화이트리스트. 초과 → 429 (`retry_after_seconds`) 또는 저렴 모델 자동 폴백(opt-in). 감사 로그 `ai_usage_logs` 테이블.

### 20.5 내부 에이전트 통일 (Phase 6.1)
Planning Agent의 `openai_compat` 백엔드(§3.1), Hermes(§4.1), Claude Code CLI(`ANTHROPIC_BASE_URL`)도 기본값을 Gateway로 설정. 플랫폼 전체 AI 비용을 단일 대시보드에서 본다. 현재(Phase 6 MVP)는 내부 에이전트가 Gemini 직접 호출 중.

### 20.6 `agent-model-mcp` backend 통합 (Phase 6.1)
리포의 slot 개념(`fast`/`orchestrator`/`deep`/`code`/`longtext`)을 Gateway 논리 이름과 매핑. Gateway 요청의 `model` 필드를 slot으로 해석해 `model_ask` MCP 툴로 디스패치. 로컬 Mac Studio(Ollama) 도입 시 `LOCAL=true` 한 줄로 전체 전환.

### 20.7 장애·레이턴시
- Gateway `/healthz` 주기 ping (Phase 6.1). 실패 시 "AI 기능 일시 중단" 배너.
- 생성 앱 SDK 래퍼에 mock-first fallback(ADR 0005) 포함 — Gateway 5xx 시 mock 응답으로 graceful degradation.
- 같은 호스트(Docker Desktop mac)에서 `host.docker.internal:4000` 통신 — 수 ms. LLM upstream이 외부 의존이라 추가 단일 장애점의 체감 증가는 제한적.

### 20.8 구현 상태
- ✅ Phase 6 MVP 완료 (PR #5 `feat/ai-gateway-mvp`) — orchestrator 내장 `/api/ai/v1/*`, 토큰 발급·해시 인증·Gemini forward 작동, 라이어 게임 E2E 검증.
- ⏳ Phase 6.1 — 내부 에이전트 통합, 사용량 로깅, 예산 cap, passthrough, agent-model-mcp backend, 대시보드 카드.
