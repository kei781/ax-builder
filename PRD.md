# PRD: AI Product Builder Platform

> **비개발자가 아이디어를 제품으로 만들 수 있는 AI 네이티브 플랫폼**
> Planning Agent(Gemini)가 유저와 대화하며 PRD를 구조화하고, Building Agent가 PRD를 기반으로 Claude Code CLI를 단계적으로 호출하여 코드를 생성·검증·배포한다.

> **시스템 구조·책임 분리·상태 머신·계약(contract)은 [ARCHITECTURE.md](./ARCHITECTURE.md)를 참조.**
> 이 문서(PRD.md)는 **무엇을 만드는가(제품 사양)**, `ARCHITECTURE.md`는 **어떻게 만드는가(시스템 구조)**.
> 두 문서가 충돌할 경우 `ARCHITECTURE.md`가 시스템 구조에 대한 SSoT다.

---

## 1. 배경 및 문제 정의

### 문제
- 사내 해커톤에서 동일한 Claude를 사용했음에도 개발자는 배포까지 완료한 반면, 비개발자는 .html 파일 하나를 만드는 수준에서 멈췄다.
- 비개발자는 "뭐가 불편해?"라고 물으면 "다 불편해"라고 답하거나, 자신의 문제가 프로세스화 불가능하다고 판단하여 순수한 노가다만이 유일한 해결책이라 믿는 경향이 있다.
- 아무리 모델 체급이 크고 강력해도, 챗봇이라는 Raw한 인터페이스는 비개발자에게 너무 날것이다. "AI로 니 문제를 해결해"는 작동하지 않는다.

### 핵심 전제
- 스스로 해결하는 구조는 지켜줘야 한다. 스스로 문제를 해결할 수 있는 창구가 있고, 해결 가능성을 경험할수록 더 적극적으로 문제해결을 시도하게 된다.
- AI 코드는 저렴하다. 한없이 인스턴트한 프로덕트를 만들어도 된다. 한 사람의 문제만 해결하는 1인 전용 제품도 가치가 있다.

### 해결 방향: 에이전트 레이어 아키텍처
- **Planning Agent (문제 구조화 + PRD 생성)**: 린 캔버스, 유저 스토리 맵 등 프레임워크를 활용하여 모호한 불편함을 "기술적으로 해결 가능한 문제"로 쪼개고, PRD/DESIGN.md를 생성하며, 완성도 자체 평가 후 빌드 핸드오프를 제안
- **Building Agent (지속적 구현)**: 확정된 PRD를 기반으로 PHASES.md를 동적 생성하고, phase별 격리된 Claude Code CLI를 호출하여 코드를 자동 생성. PRD가 SSoT이며, 코드는 항상 PRD에 정렬됨
- **QA**: npm install + health check 실행 (MVP). 실패 시 Planning으로 즉시 반송
- **비개발자 친화적 UI**: AI가 뭘 하고 있는지, 진척도가 어디인지, 완성도가 몇 %인지 사용자가 항상 인지할 수 있어야 함

---

## 2. 기술 스택

| 레이어 | 기술 | 이유 |
|---|---|---|
| Frontend | React + TypeScript + Tailwind CSS | 빠른 UI 구성, 채팅 인터페이스 |
| Orchestrator | NestJS + TypeScript | 상태 머신 소유, WebSocket 허브, DB 소유, 에이전트 생명주기 관리 |
| Database | SQLite (better-sqlite3) | 단일 파일, 외부 DB 서버 불필요, 인프라 단순화 |
| Planning Agent | Python FastAPI + 자체 LLM 추상화 레이어 | 스트리밍 대화, OpenAI 호환 API, 로컬 모델 전환성 확보 |
| LLM (Planning) | Gemini 3 Flash (gemini-3-flash-preview) | 빠른 응답, 저비용; `.env` slot 매핑으로 로컬 모델 전환 가능 |
| Building Agent | Python subprocess + Hermes(Gemini) + Claude Code CLI | PHASES.md 동적 생성, phase별 격리 실행, 최고 품질의 코드 생성 |
| **AI Gateway** | **orchestrator 내장 `/api/ai/v1/*` (MVP) / Phase 6.1에서 agent-model-mcp backend 통합** | **플랫폼·생성 앱·에이전트의 모든 LLM 호출 단일 경유. 비용·사용 통제, 키 일원화, 모델 교체 투명성 (§9.0·§18)** |
| 컨테이너 격리 | Docker | 프로젝트별 격리, 포트 관리 |
| 리버스 프록시 | Nginx | 포트 라우팅, 도메인 매핑 |

---

## 3. 시스템 아키텍처

### 3.1 3-tier 구조

```
┌─────────────────────────────────────────────────────────────┐
│ NestJS Orchestrator                                          │
│  - UI 서빙 / 인증 / 권한 검증                                 │
│  - 프로젝트 상태 머신 소유 (§10.1)                            │
│  - 에이전트 프로세스 생명주기 관리 (spawn/timeout/cleanup)    │
│  - WebSocket 이벤트 허브                                      │
│  - DB 소유자 (SQLite, better-sqlite3)                        │
│  - AI Gateway 토큰 발급·주입 (§9.0)                           │
└──────┬──────────────────┬──────────────────┬────────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌───────────────┐ ┌───────────────┐ ┌──────────────────────────┐
│ Planning Agent│ │ Building Agent│ │ AI Gateway               │
│  (FastAPI)    │ │  (Python)     │ │ orchestrator 내장 (MVP)   │
│ - 대화 스트림 │ │ - PHASES 생성 │ │ /api/ai/v1/* (OpenAI호환) │
│ - PRD/DESIGN  │ │ - Claude Code │ │ - 프로젝트 토큰 Bearer    │
│ - handoff     │ │ - QA·bounce   │ │ - Gemini upstream forward │
└──────┬────────┘ └──────┬────────┘ └─────────▲────────────────┘
       │                 │                    │
       │ LLM 호출        │ LLM 호출           │ LLM 호출 (배포 앱)
       └─────────────────┴────────────────────┤
                                              │
                                 ┌────────────┴─────────────┐
                                 │ 생성된 앱 컨테이너(들)    │
                                 │  AX_AI_TOKEN 주입됨       │
                                 └──────────────────────────┘
```

플랫폼 내 모든 LLM 트래픽은 AI Gateway를 단일 경유. 생성 앱은 직접 provider(Anthropic/Gemini/OpenAI) 키를 보유하지 않는다(§9.0).

### 3.2 전체 플로우

```
[User] → [Web UI] → [NestJS Orchestrator]
                         │
                         ├── (draft → planning) Planning Agent WebSocket 연결
                         │      └── 대화 → PRD.md / DESIGN.md / handoff.json 생성
                         │
                         ├── (plan_ready) 유저 "빌드 시작" 클릭
                         │
                         └── (building) Building Agent spawn
                                └── Hermes: PHASES.md 동적 생성
                                      └── for each phase:
                                            ├── Claude Code CLI spawn (격리)
                                            └── QA → 실패 시 Planning 반송
                                                        ↓ 성공
                                              [포트 할당 + 배포 → deployed]
```

### 3.3 세션 관리

Planning Agent는 프로젝트당 long-lived 프로세스로 동작한다.

```
Planning Agent:
  세션 시작 시:
  1. DB에서 project_id 기준으로 conversation_messages + session_summaries 로드
  2. "요약 + 최근 N턴 원문"으로 프롬프트 구성
  3. 토큰 단위 스트리밍 응답 → Nest WebSocket → 프론트엔드

  10분 유휴: 상태 체크포인트를 DB에 저장 (크래시 복구용)
  30분 유휴: 프로세스 메모리 언로드. 다음 재개 시 DB에서 복원

Building Agent:
  NestJS가 spawn(python orchestrator.py) 호출
  Hermes 층: PRD + DESIGN + handoff.json → PHASES.md 생성
  Claude Code 층: phase별 격리 세션 (각 phase마다 새 서브프로세스)
```

---

## 4. 데이터 모델

DB 엔진: **SQLite (better-sqlite3)**. 플랫폼 자체 데이터(유저, 프로젝트, 대화, 빌드)를 모두 단일 `.db` 파일에 저장한다.

### 4.1 users

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  -- 유저 단위 정적 속성 (명시적으로 설정, 암묵적 학습 없음)
  is_developer INTEGER DEFAULT 0,         -- 개발자 여부 (0: 비개발자, 1: 개발자)
  explanation_depth TEXT DEFAULT 'simple', -- 설명 깊이 ('simple' | 'detailed')
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 4.2 projects

상태 머신 소유. `ARCHITECTURE.md §7` 참조.

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT DEFAULT 'draft',
  -- state: 'draft' | 'planning' | 'plan_ready' | 'building' | 'qa'
  --      | 'awaiting_env' | 'env_qa' | 'deployed' | 'failed' | 'modifying'
  current_session_id TEXT DEFAULT NULL,
  current_version INTEGER DEFAULT 0,
  port INTEGER DEFAULT NULL,
  container_id TEXT DEFAULT NULL,
  project_path TEXT DEFAULT NULL,
  git_remote TEXT DEFAULT NULL,
  -- ADR 0002: env_qa 실패 누적 카운터 (env_rejected 한정).
  -- 3회 도달 시 schema_bug로 에스컬레이트 → Planning bounce.
  -- 성공 배포 시 0 리셋.
  env_attempts INTEGER DEFAULT 0,
  -- ADR 0003 / Phase 6: AI Gateway 프로젝트 토큰의 SHA-256 hex 해시.
  -- 평문 토큰은 project_env_vars.AX_AI_TOKEN(system-injected)에 AES-GCM
  -- 암호화 저장. 이 해시는 Gateway Bearer 인증 O(1) 역조회용. NULL=토큰 없음.
  ai_token_hash TEXT DEFAULT NULL,
  locked_until TEXT DEFAULT NULL,
  lock_reason TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
```

### 4.3 sessions

프로젝트 대화·빌드의 생명주기 단위. 빌드 완료 전까지 유지. 빌드 성공 후 수정 시 새 세션 생성.

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT DEFAULT 'active',  -- 'active' | 'archived'
  created_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT DEFAULT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
```

### 4.4 conversation_messages

대화 원문 전부 저장 (로깅·디버깅 우선).

```sql
CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT,                    -- NULL이면 에이전트 initiated
  role TEXT NOT NULL,              -- 'user' | 'assistant' | 'tool_call' | 'tool_result'
  content TEXT NOT NULL,
  tool_name TEXT DEFAULT NULL,     -- role='tool_call'일 때
  turn_index INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
```

### 4.5 session_summaries

압축 타이밍(50턴 초과, N 토큰 도달, 30분 미활동)에 생성되는 누적 요약.

```sql
CREATE TABLE session_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  covered_turn_start INTEGER NOT NULL,
  covered_turn_end INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

### 4.6 handoffs

Planning → Building 핸드오프 페이로드. 빌드 반송 시 gap 리스트 추가.

```sql
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prd_path TEXT NOT NULL,
  design_path TEXT NOT NULL,
  handoff_json TEXT NOT NULL,      -- handoff.json 전문 (JSON 직렬화)
  direction TEXT NOT NULL,         -- 'planning_to_building' | 'bounce_back'
  bounce_gaps TEXT DEFAULT NULL,   -- bounce-back 시 실패 gap 리스트 (JSON)
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

### 4.7 builds

빌드 실행 단위.

```sql
CREATE TABLE builds (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  status TEXT DEFAULT 'running',   -- 'running' | 'success' | 'failed' | 'cancelled'
  phases_md_path TEXT DEFAULT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT DEFAULT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (handoff_id) REFERENCES handoffs(id)
);
```

### 4.8 build_phases

phase별 실행 이력. QA 결과 + 반송 근거 보존.

```sql
CREATE TABLE build_phases (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  phase_name TEXT NOT NULL,        -- PHASES.md에서 동적 생성된 phase명
  phase_index INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',   -- 'pending' | 'running' | 'success' | 'failed'
  claude_log TEXT DEFAULT NULL,    -- Claude Code stdout 원문
  qa_result TEXT DEFAULT NULL,     -- QA 결과 JSON
  error_message TEXT DEFAULT NULL,
  started_at TEXT DEFAULT NULL,
  finished_at TEXT DEFAULT NULL,
  FOREIGN KEY (build_id) REFERENCES builds(id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
```

### 4.9 project_versions

배포 성공마다 git 커밋 + 버전 기록. 수정 실패 시 이전 버전 복원.

```sql
CREATE TABLE project_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  version_number INTEGER NOT NULL, -- 1, 2, 3, ...
  git_commit_hash TEXT NOT NULL,
  deployed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (build_id) REFERENCES builds(id)
);
```

### 4.10 agent_logs

에이전트 프롬프트/응답 원문 전부 저장 (디버깅·비용 추적).

```sql
CREATE TABLE agent_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent TEXT NOT NULL,             -- 'planning' | 'building_hermes' | 'building_claude'
  event_type TEXT NOT NULL,        -- 'prompt' | 'response' | 'tool_call' | 'tool_result' | 'error'
  phase TEXT DEFAULT NULL,         -- Building Agent phase명 (해당 시)
  payload TEXT NOT NULL,           -- 원문 (JSON 직렬화)
  token_count INTEGER DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
```

### 4.11 project_memory

프로젝트 단위 메모리. Planning Agent가 `search_memory` / `update_memory` 도구로 읽고 씀.

```sql
CREATE TABLE project_memory (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,               -- 메모리 항목 키
  value TEXT NOT NULL,             -- 메모리 항목 값
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  UNIQUE(project_id, key)
);
```

### 4.12 project_permissions

```sql
CREATE TABLE project_permissions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer', -- 'owner' | 'editor' | 'viewer'
  granted_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (granted_by) REFERENCES users(id),
  UNIQUE(project_id, user_id)
);
```

### 4.13 project_env_vars

`.env.example` 파싱 결과 + 유저(또는 system) 주입값. 값은 AES-256-GCM 암호화 저장. 자세한 의미와 흐름은 §9 / ADR 0004 / ADR 0006.

```sql
CREATE TABLE project_env_vars (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  -- tier: 'system-injected' | 'user-required' | 'user-optional' (§9.1.1)
  tier TEXT NOT NULL,
  -- IV(12) || AUTH_TAG(16) || CIPHERTEXT, base64. NULL = 아직 미입력.
  value_ciphertext TEXT DEFAULT NULL,
  description TEXT DEFAULT NULL,
  issuance_guide TEXT DEFAULT NULL,
  example TEXT DEFAULT NULL,
  required INTEGER DEFAULT 1,  -- required=1 (기본) / optional=0
  -- ADR 0006 밸리데이션: .env.example의 `# 패턴:` / `# 길이:` 메타라인 추출.
  -- NULL이면 해당 검증 건너뜀 (Claude Code가 모르는 서비스에 과잉 제약 X).
  validation_pattern TEXT DEFAULT NULL,
  min_length INTEGER DEFAULT NULL,
  max_length INTEGER DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  UNIQUE(project_id, key)
);
```

암호화 키는 `AX_ENV_ENCRYPTION_KEY` 환경변수 (SHA-256으로 32바이트 파생). 미설정 시 `JWT_SECRET` 파생 dev 폴백 (운영 기동 시 경고 로그). API 응답에선 **절대 원문 반환하지 않고** 마지막 4자만 보이는 마스킹 preview(`••••••5432`)만 내려간다.

---

## 5. API 명세

### 5.1 인증

```
POST /api/auth/register     { email, name, password }
POST /api/auth/login        { email, password }
```

MVP에서는 간단한 JWT 인증으로 구현한다.

### 5.2 프로젝트

```
GET    /api/projects                         → 내 프로젝트 리스트
POST   /api/projects                         → 새 프로젝트 생성 { title }
GET    /api/projects/:id                     → 프로젝트 상세 (status, port 등)
DELETE /api/projects/:id                     → 프로젝트 삭제 (owner만)
POST   /api/projects/:id/stop               → 서비스 중지 (owner, editor)
POST   /api/projects/:id/restart            → 서비스 재시작 (ADR 0006 — owner만)
                                               · docker restart {container_id}
                                               · 10s 헬스체크 후 WS completion/error 방출
                                               · 실패해도 컨테이너 유지(롤백 여지)
```

### 5.3 프로젝트 권한

```
GET    /api/projects/:id/permissions              → 권한 목록 (owner만)
POST   /api/projects/:id/permissions              → 권한 부여 { user_email, role } (owner만)
DELETE /api/projects/:id/permissions/:user_id     → 권한 회수 (owner만)
POST   /api/projects/:id/permissions/request      → 참여 요청 (비멤버 유저)
POST   /api/projects/:id/permissions/approve/:uid → 요청 승인 (owner만)
```

### 5.4 대화 (Planning Agent)

Planning Agent와의 대화는 WebSocket으로 스트리밍된다. HTTP는 이력 조회 및 취소에만 사용.

```
POST /api/projects/:id/chat/messages
  Request:  { message: string }
  Response: { message_id: string }   → 실제 응답은 WebSocket으로 스트리밍

GET  /api/projects/:id/chat/history
  Response: { messages: ConversationMessage[], summaries: SessionSummary[] }

DELETE /api/projects/:id/chat/cancel  → 스트리밍 중 취소
```

### 5.5 빌드

```
POST /api/projects/:id/build           → 빌드 시작 (plan_ready 상태에서 유저 수동 승인)
POST /api/projects/:id/build/cancel    → 빌드 중단
GET  /api/projects/:id/build/status    → 현재 빌드 상태 + phase 목록
GET  /api/projects/:id/build/logs      → phase별 로그
```

### 5.6 WebSocket (실시간 이벤트)

```
ws://host/ws/projects/:id

이벤트 스키마 (통일):
{
  "agent": "planning" | "building",
  "project_id": "...",
  "event_type": "progress" | "log" | "error" | "user_prompt" | "phase_start" | "phase_end",
  "phase": "...",
  "progress_percent": 0,
  "payload": { /* event-specific */ }
}

Planning 이벤트:
  - agent_token:      { token: string }               — 스트리밍 토큰
  - tool_call:        { tool: string, args: object }  — 도구 호출 중
  - tool_result:      { tool: string, result: object }
  - completion:       { message_id: string }
  - user_prompt:      { question: string }            — agent-initiated 질문
  - completeness:     { scores: object, label: string } — 완성도 자체 평가

Building 이벤트:
  - phase_start:      { phase_name: string, phase_index: number, total_phases: number }
  - phase_end:        { phase_name: string, status: 'success' | 'failed',
                        observed_port?: number, detail?: string, gap_list?: string[] }
  - build_complete:   { success: boolean, url: string, port: number }
  - build_failed:     { phase: string, reason: string, gap_list: string[] }
  - qa_result:        { passed: boolean, details: object }
  - error(env_qa):    { kind: 'env_qa_failure',
                        classifier: 'env_rejected' | 'transient' | 'code_bug' | 'schema_bug' | 'unknown',
                        matched_rule: string | null,
                        reason_snippet: string | null,
                        next_state: 'awaiting_env' | 'planning' | 'env_qa',
                        message: string }  // §8.3 ADR 0002
```

### 5.7 환경 변수

env 관리 엔드포인트는 §9.3 / ADR 0006 참조. 요약:

```
GET    /api/projects/:id/env           → user-tier 목록 (마스킹 preview, system 숨김)
PUT    /api/projects/:id/env           → 부분 업데이트 { vars: [{key, value}],
                                         apply?: boolean }  (ADR 0006 §D2·D6)
                                         · apply=false (기본): DB만 갱신, 컨테이너 영향 無
                                         · apply=true: 저장 + docker restart + 헬스체크
                                         · 또는 awaiting_env 상태면 env_qa 자동 트리거
GET    /api/projects/:id/env/guide     → 발급 가이드 + 밸리데이션 메타 +
                                         any_missing_required 플래그
POST   /api/projects/:id/env/rollback  → (미구현, 501)
```

**밸리데이션 (ADR 0006 §D4)** — PUT 시 서버가 각 value에 대해 `validation_pattern`, `min_length`, `max_length` 검사. 실패 시 400 응답:
```jsonc
{
  "statusCode": 400,
  "message": "환경변수 검증 실패",
  "errors": [
    { "key": "STRIPE_SECRET_KEY", "reason": "pattern_mismatch",
      "hint": "예: sk_test_..." }
  ]
}
```

owner/editor만 호출 가능. 재시작은 owner만(§5.2). 실제 값은 AES-256-GCM 암호화 저장 (§4.13).

### 5.8 AI Gateway (§18 참조)

생성된 앱 컨테이너에서 LLM 호출에 사용하는 엔드포인트. JWT 인증이 아닌 **프로젝트 토큰 Bearer 인증**을 사용한다.

```
POST /api/ai/v1/chat/completions   → OpenAI-호환, SSE 스트리밍 지원 (§18.1)
POST /api/ai/v1/models             → 토큰 유효성 + 가용 논리 모델 목록
```

`Authorization: Bearer axt_*` 헤더 필수. 토큰이 유효하지 않으면 401 `{"message":"토큰이 존재하지 않거나 폐기됨"}`.

---

## 6. Planning Agent 상세

### 6.1 기술 스택

- **런타임**: Python FastAPI. 자체 구현 LLM 추상화 레이어(`planning-agent/app/agent/llm/`) 사용.
- **현재 모델**: `gemini-3-flash-preview` (Gemini API).
- **모델 추상화**: slot/backend/lifecycle 개념.
  - **슬롯(역할)**: `chat` / `summarize` / `eval` / `tool_arg`
  - **백엔드**: `openai_compat` / `ollama` — `LLM_BACKEND` 환경변수 하나로 전환
  - `.env`의 slot 매핑만 교체하면 로컬 모델(qwen3:32b, gemma-4-31b 등)으로 전환 가능
- **Orchestrator ↔ Planning Agent**: WebSocket (양방향, 스트리밍).

### 6.2 프로세스 모델

- **long-lived 프로세스**. 프로젝트당 한 프로세스가 살아있다.
- **10분 유휴**: 상태 체크포인트를 DB에 저장.
- **30분 유휴**: 프로세스 메모리 언로드. 다음 대화 시 DB에서 복원 후 재기동.
- 세션 ID는 빌드 완료까지 유지. 언로드는 캐시 비움일 뿐, 세션은 살아있다.

### 6.3 허용 도구

| 도구 | 설명 | 허용 |
|---|---|---|
| `write_prd` | PRD.md 생성/갱신 | ✅ |
| `write_design` | DESIGN.md 생성/갱신 | ✅ |
| `ask_user` | 에이전트 initiated 질문 | ✅ |
| `search_memory` | project_memory 조회 | ✅ |
| `update_memory` | project_memory 갱신 | ✅ |
| `evaluate_readiness` | 완성도 자체 평가 + label 표시 | ✅ |
| `propose_handoff` | handoff.json 생성 + 빌드 시작 제안 | ✅ |
| 웹 검색 / 외부 레퍼런스 | | ❌ |
| 파일 시스템 기타 | | ❌ |

### 6.4 스트리밍

- 토큰 단위 스트리밍 필수.
- 도구 호출 중간 이벤트(`searching memory...`, `updating PRD section X...`) Nest 경유로 프론트에 중계.
- 취소 지원 (유저가 스트리밍 도중 중단 가능).

### 6.5 Planning 결과물

- `PRD.md` — 제품 사양, SSoT
- `DESIGN.md` — UI/UX 사양, SSoT
- `handoff.json` — 구조화된 품질 메타데이터

`PHASES.md`는 Planning이 생성하지 않는다 — Building Agent의 Hermes 층이 생성한다.

### 6.6 완성도 평가 (스코어)

Planning Agent가 `evaluate_readiness` 도구로 자체 평가한다. 에이전트의 판단은 **제안**, 최종 빌드 승인은 **유저**.

| 항목 | 가중치 |
|---|---|
| problem_definition | 0.0 ~ 1.0 |
| feature_list | 0.0 ~ 1.0 |
| user_flow | 0.0 ~ 1.0 |
| feasibility | 0.0 ~ 1.0 |
| user_experience | 0.0 ~ 1.0 |

completeness 종합이 "최소 조건 충족" 이상이면 `propose_handoff` 도구로 빌드 시작 제안. UI에 "빌드 시작" 버튼 활성화.

### 6.6.1 핸드오프 프로세스와 환각 방지

자세한 단계별 흐름은 **ARCHITECTURE §6.5**, 실패 모드는 **§6.6** 참조. 핵심 불변식:

- **상태 전이는 오직 `propose_handoff` 도구의 실제 호출로만 발생**한다. `evaluate_readiness`는 스코어 스냅샷이며 전이와 무관.
- Planning Agent가 "이관 완료" / "핸드오프 제안했습니다"를 도구 호출 없이 텍스트로만 출력하면 **환각**이다 — state가 안 바뀌어 UI는 계속 "AI에게 핸드오프 요청" CTA를 유지한다.
- bounce-back이 발생하면 state는 `planning`으로 되돌아가지만 이전 handoff 행은 이력 보존을 위해 DB에 남는다. 다음 핸드오프 요청은 **새 `propose_handoff` 호출이 반드시 필요**하다.

이 환각을 막는 3중 방어:
1. **시스템 프롬프트** (`system_prompt.py`) — "도구 호출 없이 완료 선언 금지" 명시.
2. **프론트 워치독** (`Chat.tsx`) — 핸드오프 요청 전송 후 15초 내 `plan_ready` 전이가 안 보이면 "AI가 도구를 호출하지 않은 것 같아요, 다시 요청해주세요" 배너.
3. **백엔드 원자성** (`propose_handoff.py`) — INSERT handoff + UPDATE projects.state를 한 함수 안에서 수행. UPDATE rowcount가 0이면 반환값의 `transitioned_to_plan_ready`가 자연스럽게 false가 되어 상태와 답변이 일치.

### 6.7 시스템 프롬프트 방향

```
당신은 비개발자의 모호한 불편함을 "기술적으로 해결 가능한 문제"로 구조화하는
Planning Agent입니다. 단순한 PRD 평가가 아니라, 사용자의 문제를 함께 쪼개는
과정을 진행합니다.

## 대화 단계

### 1단계: 문제 발견 (Lean Canvas 기반)
- "어떤 상황에서 불편함을 느끼시나요?" (Problem)
- "지금은 어떻게 해결하고 계세요?" (Existing Alternatives)
- "이게 해결되면 어떤 상태가 되면 좋겠어요?" (Value Proposition)

### 2단계: 기능 구조화 (User Story Map 기반)
- 유저 스토리로 전환: "그러면 [사용자]가 [목표]를 달성하려면..."
- 각 단계를 "~할 수 있다" 형태의 기능으로 정리

### 3단계: 기술적 실현 가능성 검증
- 외부 API 의존성 확인
- 단일 웹앱으로 구현 가능한 범위로 스코프 조절
- 비개발자 용어로 기술적 제약 설명

## 규칙
- 한 번에 질문은 최대 2개
- 비개발자도 이해할 수 있는 용어만 사용
- 완성도가 충분해지면 propose_handoff 도구로 빌드 시작 제안
- "프로세스화가 불가능하다"고 느끼는 사용자도 있으므로 작은 단위로 쪼개서 질문
```

---

## 7. Building Agent 상세

### 7.1 2-layer 구조

```
NestJS ──spawn──> orchestrator.py (Python)
                      │
                      ├── [Hermes 층] Gemini: PRD + DESIGN → PHASES.md 동적 생성
                      │
                      └── for each phase in PHASES.md:
                            ├── spawn(claude --prompt=...)  ← 격리 세션
                            ├── 실행 완료 대기
                            └── QA 실행 → 실패 시 즉시 Planning 반송
```

### 7.2 Hermes 층 (감독, Gemini)

- **역할**:
  1. PRD + DESIGN + handoff.json 읽기
  2. **PHASES.md 동적 생성** — 프로젝트 특성에 맞게 phase 분해 (Scaffold / Backend / Frontend / Integration / QA 등). 고정 템플릿이 아니라 PRD 내용 기반 생성.
  3. phase별 Claude Code 디스패치
  4. QA 실행·감독
  5. bounce-back 판단 (실패 시 즉시 Planning 반송)
- **모델 슬롯**: `phase_planner` → `deep`, `qa_judge` → `fast`
- **리스크**: 동적 phase 생성 품질이 Gemini 모델의 PRD 해석력에 의존. 품질 저하 감지 시 고정 템플릿 fallback 고려.

### 7.3 Claude Code 층 (실행)

- **호출 방식**: phase별 격리 세션. 각 phase마다 `claude` 서브프로세스를 새로 spawn.
- **이유**: 긴 컨텍스트로 인한 품질 저하 방지, phase 간 오염 차단.
- **프롬프트 조립**: 각 phase 시작 시 주입:
  - `PRD.md` 전문
  - `DESIGN.md` 전문
  - `PHASES.md`에서 현재 phase 섹션
  - 이전 phase들의 요약 (완료 파일 경로 + 완료 상태)
- **권한**: Read / Write / Edit / Bash / Glob / Grep 전체.

### 7.4 QA (MVP)

MVP에서의 QA는 최소한으로 구현한다:

1. `npm install` 실행 — 의존성 오류 감지
2. `npm start &` 후 `curl http://localhost:{port}/health` — 프로세스 기동 확인

QA 실패 조건: npm install 에러 또는 health check 응답 없음.

### 7.5 반송(bounce-back) 정책

- 어느 phase든 **1회라도 실패** → 즉시 Planning Agent로 반송.
- 반송 시 실패 사유를 **구조화된 gap 리스트**로 Planning에 전달.
- max retry 없음 — 실패 = 즉시 반송.
- Planning은 원래 세션 재개. `handoff.json`에 실패 gap 리스트 추가.

### 7.6 빌드 규칙 (Claude Code에 주입)

```
- 데이터 저장이 필요하면 반드시 SQLite 사용 (./data/app.db)
- MySQL, PostgreSQL 등 외부 DB 의존 금지
- 최소한의 파일 구조
- README.md에 실행 방법 기록
- 외부 API 키·시크릿은 환경변수로 처리. **`.env.example`을 §9.2 규격에 맞춰 반드시 생성**(미생성 시 QA 선제 체크에서 bounce-back)
- **LLM 호출은 반드시 ax-builder AI Gateway 경유**(§9.0). `process.env.AX_AI_BASE_URL` + `process.env.AX_AI_TOKEN`을 OpenAI-호환 엔드포인트로 사용. **Anthropic/Gemini/OpenAI provider 키 직접 참조·하드코딩 금지** (스캐폴드 QA 선제 체크에서 `ANTHROPIC_API_KEY`·`OPENAI_API_KEY`·`GEMINI_API_KEY`·`GOOGLE_API_KEY` 등 provider 키 식별자 grep → 검출 시 bounce-back)
- **[ADR 0005] env 의존 모듈은 반드시 mock/real 분기 구현**. 앱은 env 값이 비어 있어도 mock으로 완전히 동작해야 하며, env가 채워지면 자동으로 real로 전환됨. 아래 패턴을 따른다:
    ```js
    // services/llm.js  (예시)
    const REAL = !!process.env.AX_AI_TOKEN;
    async function chat(prompt) {
      if (REAL) return callRealLLM(prompt);
      // mock: 결정적·설명적 응답 (⚠ 마커 포함)
      return { content: `⚠ mock 응답입니다. 환경 설정 후 실제 호출로 전환됩니다.\n입력: ${prompt.slice(0, 60)}` };
    }
    ```
  QA 선제 체크: env 의존 모듈 파일에서 `process.env.<AX_*>` 참조 + 분기문 존재 여부 grep, 없으면 bounce-back.
- package.json scripts에 "start" 커맨드 반드시 포함
- 앱은 원하는 단일 포트 하나에 바인드하면 된다. 시스템은 `npm start` 후 프로세스가 실제 LISTEN 중인 포트를 관찰하여 라우팅한다(§8.1). **`PORT` 환경변수 주입은 없으며, 앱이 어떤 포트를 고르든 무방**하다 — 컨테이너 격리 덕에 호스트 포트 충돌은 배포 계층에서 해결된다
- `.env.example`의 민감 키는 선택 사항으로 `# 패턴:` / `# 길이:` 메타라인을 포함하면 유저 입력 UI에서 인라인 검증이 활성화된다(ADR 0006). 모르는 포맷은 생략해도 무방.
```

---

## 8. QA 및 수정 루프

### 8.1 QA 흐름 (관찰 기반 + mock-first)

QA는 두 가지 원칙을 동시에 만족한다:
- **관찰 기반 (ADR 0001)** — 앱이 어느 포트에 바인드할지 주입하지 않고 관찰. pid의 LISTEN 포트를 스캔해서 HTTP 응답 확인.
- **Mock-first (ADR 0005)** — env 값이 비어 있어도 앱은 mock 모듈로 완전히 기동·응답해야 함. 초기 빌드 QA는 env 값 부재 상태에서 통과해야 함.

즉 QA는 **앱 구조가 정상인지**를 검증한다 — 포트 바인드, 라우팅, mock 응답 경로, 에러 핸들링. **실제 env 값 유효성은 배포 후 env_qa 단계(§9)**에서 별도 검증된다.

```
Building Agent (orchestrator.py)
  ├── phase 완료
  ├── [선제 체크] package.json 존재 + scripts.start 존재 + .env.example 존재
  │     → 하나라도 누락: 즉시 Planning 반송 (gap_list에 누락 항목 명시)
  ├── npm install 실행
  │     → 실패: 즉시 Planning 반송
  ├── npm start (백그라운드; PORT env 주입 없음)
  ├── detect_bound_port(pid): 최대 30초 폴링
  │     → 프로세스의 LISTEN 소켓 목록 스캔
  │     → 복수 포트면 각각 `/` HEAD 요청 → 2xx/3xx 반환 포트 선택
  │     → 관찰 성공: port를 build_phases에 기록 → .env 단계(§9) 또는 deployed
  │     → 관찰 실패: FailureClassifier(§8.3)로 원인 분류 → 해당 브랜치 실행
```

### 8.2 자기 참조적 수정 플로우

배포 후 버그 리포트·개선 요청 시에도 동일 구조를 따른다. 코드를 직접 수정하지 않고, PRD를 먼저 업데이트 후 Building Agent가 PRD 기준으로 재정렬한다.

```
1. 유저가 수정 요청 메시지 입력 (새 세션 생성, project.status = 'modifying')
2. Planning Agent가 수정 요구사항 구조화 + PRD 업데이트
3. 유저 "빌드 시작" 클릭
4. Building Agent: 업데이트된 PRD 기준으로 PHASES.md 재생성 + 코드 재정렬
5. QA 통과 → 새 버전 git 커밋 + project_versions 기록
6. 실패 시 이전 버전 git pull로 복원
```

### 8.3 실패 분류 (FailureClassifier)

QA 실패(초기 빌드 후 QA 또는 §9.1의 env 주입 후 재QA)를 **누가 고칠 수 있는가**로 분기한다. "포트 문제면 무조건 기획 반송"처럼 뭉뚱그리지 않는다.

| # | 원인 | 시그니처 예시 | 고치는 주체 | 상태 전이 |
|---|---|---|---|---|
| 1 | **env_rejected** — env 값 자체가 잘못됨 (오타·만료·권한 부족) | `401`, `403`, `Unauthorized`, `Invalid.*key`, `API key not found` | 유저 | `env_rejected` → 유저에게 env 재입력 UI, 최대 3회 |
| 2 | **transient** — 외부 서비스 일시 장애 | `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `503`, `502` | 아무도 | 현 상태 유지 + "재시도" 버튼 노출, 5분 텀 3회 자동 재시도 |
| 3 | **code_bug** — 앱 코드 자체 문제 | `SyntaxError`, `TypeError`, `ReferenceError`, 포트 미바인드(§8.1), 파싱 실패 | AI(Claude Code) | `planning`으로 bounce-back, gap_list에 스택 요약 첨부 |
| 4 | **schema_bug** — env 스키마 자체가 잘못 정의 | 케이스 1이 **같은 변수에서 3회 연속** 발생 | AI(PRD/Planning) | `planning`으로 bounce-back, gap_list에 해당 변수의 유저 입력 이력 첨부 (값 자체는 마스킹) |

**분류기 구현**
- 1차: regex 룰 테이블로 에러 로그 매칭. 확정되면 즉시 분기.
- 2차: 1차에서 미매칭이면 Gemini(`qa_judge` 슬롯)에게 "이 로그의 원인은 env/transient/code 중 무엇인가"로 구조화된 판정 요청.
- 2차도 모호하면 안전하게 **code_bug로 판정**(유저를 반복 재입력 지옥에 두지 않음).

**재시도 카운터 관리**
- env 재입력 시도 수는 `builds` 단위로 카운트 (새 빌드 시작 시 리셋).
- 같은 변수에서 3회 실패 시 케이스 4로 자동 에스컬레이트.
- transient 재시도는 지수 백오프(1분 → 5분 → 15분) + 수동 재시도 버튼.

---

## 9. 환경 변수(ENV) 관리

### 9.0 AI Gateway (agent-model-mcp)

**왜 필요한가** — 비개발자 UX에서 "API 키 발급받아서 넣으세요"는 거의 치명적이다. 또 생성된 앱이 직접 provider 키를 들고 있으면 유출·비용 폭주·사용 통제 불능 문제가 생긴다. 플랫폼이 **단일 게이트웨이**를 두고 모든 LLM 호출을 경유시킨다.

**역할**
- **OpenAI-호환 HTTP API**: 생성된 앱들은 `openai` SDK에 `base_url = AX_AI_BASE_URL` 설정만 하면 그대로 호출 가능 (스트리밍 SSE 포함).
- **MCP 인터페이스**: Claude Code / Planning / Hermes 등 내부 에이전트는 MCP 툴(`generate`, `embed`, `complete_stream`)로 호출.
- **모델 라우팅**: 앱은 `model: "default" | "cheap" | "reasoning"`처럼 **논리 이름**을 지정. 게이트웨이가 실제 모델(claude-haiku/sonnet/gemini-flash 등)로 매핑. 상위 모델 출시 시 설정만 바꿔서 전체 앱 혜택.
- **인증**: 프로젝트당 1개 `AX_AI_TOKEN` 발급. 빌드 완료 시 orchestrator가 컨테이너 env로 자동 주입. 유저 UI에 **노출되지 않는다**.
- **예산·속도 제한**: 프로젝트별 일일/월 cap, 초과 시 429 또는 저렴 모델 자동 폴백(opt-in). IP 이상치 탐지.
- **감사 로그**: 모든 호출을 프로젝트·토큰 단위로 기록. 대시보드에서 사용량·비용 조회.
- **뒷단 passthrough 모드**: OpenAI-호환 포맷으로 담기 어려운 기능(Anthropic tool use, thinking, caching 등)은 원본 포맷 직접 전달 엔드포인트 병행.

**내부 에이전트 통일** — Planning Agent의 `openai_compat` 백엔드(§6.1), Hermes(§7.2), Claude Code CLI(`ANTHROPIC_BASE_URL`)도 전부 이 게이트웨이를 가리키도록 구성한다. 플랫폼 운영자만 원본 provider 키를 보유.

**장애 내성** — 게이트웨이가 죽으면 플랫폼 전체가 정지한다. health check + 자동 재시도 + 생성 앱 SDK 래퍼에 graceful degradation 힌트. 외부 provider API도 어차피 네트워크 의존이라 추가 단일 장애점의 체감 증가는 제한적.

**API 스펙** — 별도 §18에 정리(OpenAI-호환 엔드포인트 목록, MCP 툴 목록, 인증 헤더, 사용량 조회 등).

### 9.1 플로우 (mock-first, ADR 0005)

env는 **배포의 선행 조건이 아니라 점진적 향상**이다. 앱은 env 없이도 mock 모듈로 완전히 돌아가며(§7.6), env 입력은 "실제 기능 활성화"라는 후행 단계다.

#### 9.1.1 env 3분류

`.env.example`의 각 변수는 `# 주입: <kind>` 메타라인으로 분류된다. 비지정 시 `user-required`로 간주한다.

| 분류 | 누가 주입 | 유저 UI 노출 | 예 |
|---|---|---|---|
| **system-injected** | orchestrator가 빌드 완료 시 자동 | ❌ 숨김 | `AX_AI_TOKEN`, `AX_AI_BASE_URL`, `AX_STORAGE_PATH` |
| **user-required** | 유저가 직접 | ✅ 필수 입력 | Stripe API key, 카카오맵 키 등 외부 비-AI 서비스 |
| **user-optional** | 유저가 원하면 | ✅ 선택 입력 | 추가 기능 토글용 외부 키 |

**regex 가드레일** — Claude Code가 생성한 `.env.example`에서 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` 등 provider 키 이름이 **user-required로 올라오면 스캐폴드 QA가 즉시 bounce-back**. LLM이 필요하면 AI Gateway를 써야 하므로 이 변수들은 user 입력 대상이 될 수 없음.

#### 9.1.2 빌드~배포 플로우

```
관찰 기반 QA 통과 (§8.1)
  → .env.example 파싱 → project_env_vars 행 upsert
      · system-injected: orchestrator가 자동 값 주입 (AX_AI_BASE_URL 등)
      · user-required / user-optional: value=NULL (mock 상태)
  → .env 파일 생성 (system 값만) → 컨테이너 기동 → deployed  ★
    ▲
    │ 이 시점에 유저는 앱 URL을 열어볼 수 있음 (mock 응답)
    │ UI 배너: "⚠ mock 응답 중 — 실제 기능은 환경 설정 후 활성화"
```

#### 9.1.3 env 입력 / 유지보수 플로우 (ADR 0006)

```
[deployed 상태, 언제든]
  유저가 대시보드 "⚙ 환경 설정" 클릭 → EnvInput 페이지 유지보수 모드
    ├── 필드별 편집 + 인라인 밸리데이션(§5.7)
    └── 저장 버튼 2종:
        ┌── [💾 저장]
        │     · DB만 갱신 (AES-256-GCM), 컨테이너 영향 無
        │     · 상태 deployed 유지
        │
        └── [💾 저장 후 재시작]
              · DB 갱신 → .env 파일 재기록 → docker restart
              · status=env_qa → 10s 헬스체크
                ├── 성공 → deployed
                ├── env_rejected → deployed 유지 + 에러 토스트
                │                  (값이 잘못됐지만 이전 컨테이너 상태 보존)
                ├── transient    → deployed 유지 + "잠시 뒤 다시" 안내
                ├── code_bug     → status='modifying' (채팅으로 수정)
                └── schema_bug   → status='planning' (기획 재검토, 극단 케이스)
```

또는 owner가 별도로 "🔄 재시작" 버튼만 눌러 현 상태 그대로 재기동할 수도 있음 (§5.2 `/restart`).

**원칙**: env 단계 실패를 **기본적으로 기획 반송하지 않는다.** 유저가 고칠 수 있는 문제(env_rejected, transient)는 토스트로 안내 + 현 배포 유지. 통합 로직 버그(code_bug)는 채팅 수정(modifying)으로 처리. 기획 반송(planning)은 env 스키마와 PRD가 모순되는 극단 케이스만.

### 9.2 .env.example 규격

```
# [변수명]
# 설명: 이 변수가 왜 필요한지 (비개발자도 이해 가능하게)
# 발급 방법: 단계별 안내
# 예시: 실제 형식 예시 (가짜 값)
# 필수 여부: required / optional
# 주입: system-injected | user-required | user-optional
VARIABLE_NAME=
```

**system-injected 예**

```
# AX_AI_BASE_URL
# 설명: ax-builder AI Gateway 엔드포인트. 이 앱의 모든 LLM 호출은 여기를 경유합니다.
# 발급 방법: 빌드 시 자동 주입 (유저가 건드릴 필요 없음)
# 예시: https://ax-ai.internal/v1
# 필수 여부: required
# 주입: system-injected
AX_AI_BASE_URL=

# AX_AI_TOKEN
# 설명: AI Gateway 프로젝트 토큰. 이 프로젝트 전용으로 발급되었습니다.
# 발급 방법: 빌드 시 자동 주입
# 예시: axt_xxxxxxxx
# 필수 여부: required
# 주입: system-injected
AX_AI_TOKEN=
```

### 9.3 API

```
GET  /api/projects/:id/env           → ENV 목록 (owner, editor만)
PUT  /api/projects/:id/env           → ENV 일괄 저장 { vars: [{key, value}] }
GET  /api/projects/:id/env/guide     → ENV별 발급 가이드
POST /api/projects/:id/env/rollback  → 이전 ENV로 롤백 + 재시작
```

ENV 값은 DB에 AES-256으로 암호화 저장. API 응답에서 마스킹 처리.

---

## 10. 프로젝트 오케스트레이션 (NestJS)

### 10.1 상태 머신 (mock-first, ADR 0005 + 0006)

```
draft → planning → plan_ready → building → qa → deployed ←──────┐
          ↑                          │                ↕          │
          │                          │           self-loop       │
          │                          │           (env 저장만,     │
          │                          │            재시작 無)       │
          │                          │                │          │
          │                          │                ▼          │
          │                          │             env_qa ────── │
          │                          │           (저장+재시작,     │
          │                          │            또는 유지보수    │
          │                          │            모드에서 진입)    │
          │                          │                │          │
          │                          │        ┌───────┼──────────┤
          │                          │        │       │          │
          │                          │    code_bug  rejected /  transient
          │                          │        │     schema_bug   / success
          │                          │        ▼        │          │
          │                          │    modifying   planning   deployed
          │                          │    (대화 수정)  (기획 반송) ────┘
          │                          │
          └────── bounce-back ───────┘
                  (phase 실행 실패, 예: QA에서 구조 문제)
                       │
                       └─> modifying (deployed 이후 수정 요청)
```

**핵심 변화(ADR 0005)**: 빌드는 **env 없이도 mock 상태로 `deployed`까지 직행**한다. `awaiting_env`는 레거시 호환 용도로 남지만 기본 플로우에서는 사용되지 않음. env 입력/수정/재시작은 모두 **`deployed` 이후의 유지보수 작업**이다.

| 상태 | 의미 |
|---|---|
| `draft` | 프로젝트 생성 직후, Planning 시작 전 |
| `planning` | Planning Agent와 대화 중 (신규 또는 bounce-back 수신) |
| `plan_ready` | 완성도 충분, 유저의 "빌드 시작" 대기 |
| `building` | Building Agent 실행 중 (phase 진행) |
| `qa` | 관찰 기반 QA 진행 중 (§8.1) — mock 상태로 구조 검증 |
| `awaiting_env` | (레거시) QA 통과했지만 ADR 0005 이전 흐름에서 required 변수가 막혀 있는 경우. ADR 0005 적용 후엔 기본 플로우에서 나타나지 않음. |
| `env_qa` | 유저가 "저장 후 재시작"을 눌렀거나 awaiting_env에서 값을 제출해 헬스체크 중 |
| `deployed` | 컨테이너 기동 완료, 접속 가능. env 유무와 무관 — mock 또는 real. |
| `modifying` | deployed 이후 수정 요청(새 세션) — env_qa의 code_bug 결과도 여기로 |
| `failed` | 해결 불가 상태 (드묾) |

### 10.2 전환 트리거

| 전환 | 트리거 |
|---|---|
| `draft → planning` | 유저 첫 메시지 입력 |
| `planning → plan_ready` | Planning Agent `propose_handoff` + 유저 UI 확인 |
| `plan_ready → building` | **유저가 "빌드 시작" 버튼 클릭** (수동 승인) |
| `building → qa` | 모든 phase 성공 (자동) |
| `qa → deployed` | 관찰 QA 통과 (mock-first — env 유무 무관) |
| `deployed → deployed` | env 저장(재시작 없음). DB만 업데이트, 상태 유지. |
| `deployed → env_qa` | "저장 후 재시작" 또는 `/restart` 호출 |
| `env_qa → deployed` | 헬스체크 통과 (성공/transient 둘 다 현 상태 유지하는 방향) |
| `env_qa → modifying` | FailureClassifier가 `code_bug`로 판정 → 대화 수정 |
| `env_qa → planning` | FailureClassifier가 `schema_bug`로 판정 (극단) |
| `deployed → modifying` | 유저 수정 요청 (새 세션 생성) |
| `qa / building → planning` | phase 실행 실패(구조 문제 bounce-back) |
| `awaiting_env → env_qa` | (레거시) 초기 설정 모드에서 유저 제출 시 |

### 10.3 핸드오프 계약

```jsonc
// handoff.json 스키마
{
  "prd_path": "/projects/{id}/PRD.md",
  "design_path": "/projects/{id}/DESIGN.md",

  "completeness": {
    "problem_definition": 0.95,
    "feature_list":       0.90,
    "user_flow":          0.85,
    "feasibility":        0.90,
    "user_experience":    0.80
  },

  "unresolved_questions": [],   // 비어 있어야 핸드오프 가능
  "assumptions_made": [         // 에이전트 임의 결정. 유저 검토용
    "기본 폰트는 Pretendard로 가정"
  ],
  "tech_constraints": {         // Building이 벗어나면 안 되는 강제 제약
    "storage": "SQLite",
    "runtime": "Node.js + Express"
  },

  "schema_version": "1.0"
}
```

markdown이 SSoT. json은 markdown 파싱 산출물. 빌드 시작 전 markdown을 파싱해 json 재생성.

### 10.4 빌드 프로세스

```typescript
// build.service.ts
async function buildProject(projectId: string) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

  // 1. 디렉토리 생성
  const projectPath = `/projects/${projectId}`;
  await fs.mkdir(projectPath, { recursive: true });

  // 2. 포트 할당 (3000~3999 중 미사용 포트)
  const port = await this.allocatePort();

  // 3. Docker 컨테이너 생성
  const containerId = await this.docker.createContainer({
    image: 'node:20-slim',
    name: `project-${projectId}`,
    portBindings: { '3000/tcp': [{ HostPort: String(port) }] },
    binds: [`${projectPath}:/app`, `${projectPath}/data:/app/data`],
    workingDir: '/app',
  });

  // 4. 상태 업데이트
  db.prepare('UPDATE projects SET status=?, port=?, container_id=? WHERE id=?')
    .run('building', port, containerId, projectId);

  // 5. Building Agent spawn (비동기)
  this.spawnBuildingAgent(projectId, projectPath, port);
}
```

---

## 11. Frontend 화면 구성

### 11.1 메인 페이지 (프로젝트 대시보드)

```
┌─────────────────────────────────────────┐
│  내 프로젝트                    [+ 새 프로젝트]  │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ 📦 Todo App          🟢 Running     │  │
│  │    만든 사람: 나 (owner)              │  │
│  │    🐳 Docker :3001                   │  │
│  │    http://localhost:3001             │  │
│  │    [수정 요청] [중지]                  │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ 📦 광고 성과 대시보드  🟢 Running    │  │
│  │    만든 사람: 김마케팅 | 나: editor   │  │
│  │    🐳 Docker :3002                   │  │
│  │    http://localhost:3002             │  │
│  │    [수정 요청]                        │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ 📦 Weather Dashboard  🔄 Building   │  │
│  │    만든 사람: 나 (owner)              │  │
│  │    Frontend phase 진행 중... (3/5)   │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ 📦 Recipe Finder      🔴 Failed     │  │
│  │    만든 사람: 나 (owner)              │  │
│  │    QA 실패 — Planning으로 반송됨      │  │
│  │    [PRD 수정하기]                    │  │
│  └─────────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### 11.2 채팅 화면 (Planning Agent 대화)

```
┌─────────────────────────────────────────────────────┐
│  새 프로젝트: Todo App                                 │
│                                                       │
│  ┌─ 완성도 ─────────────────────────────────────┐    │
│  │ 문제정의  ████████████████░░  0.80            │    │
│  │ 기능목록  █████████████░░░░░  0.65            │    │
│  │ 사용흐름  ████████████░░░░░░  0.60            │    │
│  │ 기술실현  ██████████████░░░░  0.70            │    │
│  │ 사용경험  ██████████░░░░░░░░  0.50            │    │
│  │                                               │    │
│  │  [빌드 시작]  ← 완성도 충분 시 활성화           │    │
│  └───────────────────────────────────────────────┘   │
│                                                       │
│  🤖 어떤 상황에서 불편함을 느끼시나요?                   │
│                                                       │
│  👤 할일 관리가 불편해요. 포스트잇에 적어놓는데           │
│     자꾸 잃어버려요.                                    │
│                                                       │
│  🤖 그렇군요. 지금은 어떻게 관리하고 계세요?              │
│     포스트잇 외에 다른 방법도 시도해보셨나요?              │
│                                                       │
│  [PRD 미리보기]  [메시지 입력...]            [전송]     │
└─────────────────────────────────────────────────────┘
```

### 11.3 빌드 진행 화면 (BuildStatus)

```
┌─────────────────────────────────────────┐
│  Todo App - 빌드 중                       │
│                                           │
│  ✅ Scaffold      — 완료                  │
│  ✅ Backend       — 완료                  │
│  🔄 Frontend      — 진행 중...            │
│     └ Claude Code: "App.tsx 작성 중"      │
│  ⬜ Integration                           │
│  ⬜ QA                                   │
│                                           │
│  ┌─ 실시간 로그 ──────────────────────┐   │
│  │ > Writing src/App.tsx...           │   │
│  │ > Installing dependencies...       │   │
│  │ > npm run build...                 │   │
│  └───────────────────────────────────┘   │
│                          [빌드 중단]       │
└─────────────────────────────────────────┘
```

### 11.4 UX 투명성 원칙

아래 사항은 모든 화면에서 반드시 준수한다:

1. **현재 단계 표시**: Planning / Building / QA / deployed 중 어디인지 항상 표시
2. **항목별 완성도**: 5개 항목 각각의 completeness score를 시각적으로 표시
3. **AI 작업 실황**: 빌드/수정 중일 때 "AI가 지금 뭘 하고 있는지"를 자연어로 실시간 표시
4. **phase 진척도**: 현재 phase명, 완료/전체 phase 수, 경과 시간 등 구체적 수치 제공
5. **접속 가능 상태 강조**: 배포 완료 시 URL을 가장 눈에 띄게 표시. 접속 불가 시에도 이유 명시

---

## 12. 디렉토리 구조

```
/project-root/
├── frontend/                         # React + TypeScript
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx         # 프로젝트 리스트
│   │   │   ├── Chat.tsx              # Planning Agent 채팅 + 완성도 사이드바
│   │   │   └── BuildStatus.tsx       # 빌드 phase 진행 상태
│   │   ├── components/
│   │   │   ├── ChatMessage.tsx
│   │   │   ├── CompletenessBar.tsx   # 5항목 completeness 시각화
│   │   │   ├── ProjectCard.tsx
│   │   │   └── BuildLog.tsx
│   │   ├── hooks/
│   │   │   ├── useChat.ts            # 채팅 상태 관리
│   │   │   └── useWebSocket.ts       # 실시간 이벤트 구독
│   │   └── api/
│   │       └── client.ts
│   ├── package.json
│   └── tsconfig.json
│
├── orchestrator/                     # NestJS + TypeScript (상태 머신 소유, DB 소유)
│   ├── src/
│   │   ├── auth/
│   │   │   ├── auth.module.ts
│   │   │   ├── auth.service.ts
│   │   │   └── auth.controller.ts
│   │   ├── projects/
│   │   │   ├── projects.module.ts
│   │   │   ├── projects.service.ts
│   │   │   ├── projects.controller.ts
│   │   │   └── entities/
│   │   │       ├── project.entity.ts
│   │   │       ├── session.entity.ts
│   │   │       └── build.entity.ts
│   │   ├── chat/
│   │   │   ├── chat.module.ts
│   │   │   ├── chat.service.ts       # Planning Agent WebSocket 프록시
│   │   │   └── chat.controller.ts
│   │   ├── build/
│   │   │   ├── build.module.ts
│   │   │   ├── build.service.ts      # Building Agent spawn + 오케스트레이션
│   │   │   ├── docker.service.ts     # Docker 컨테이너 관리
│   │   │   └── port-allocator.ts
│   │   ├── websocket/
│   │   │   └── events.gateway.ts     # WebSocket 이벤트 허브
│   │   ├── database/
│   │   │   └── database.service.ts   # better-sqlite3 래퍼
│   │   └── app.module.ts
│   ├── package.json
│   └── tsconfig.json
│
├── planning-agent/                   # Python FastAPI (Planning Agent)
│   ├── app/
│   │   ├── main.py                   # FastAPI 엔트리포인트
│   │   ├── agent/
│   │   │   ├── planner.py            # 대화 루프 + 도구 디스패치
│   │   │   ├── tools/
│   │   │   │   ├── write_prd.py
│   │   │   │   ├── write_design.py
│   │   │   │   ├── search_memory.py
│   │   │   │   ├── update_memory.py
│   │   │   │   ├── evaluate_readiness.py
│   │   │   │   └── propose_handoff.py
│   │   │   └── llm/
│   │   │       ├── slots.py          # slot/backend/lifecycle 추상화
│   │   │       ├── openai_compat.py  # Gemini / OpenAI 호환 백엔드
│   │   │       └── ollama.py         # 로컬 모델 백엔드
│   │   ├── memory/
│   │   │   └── memory_service.py     # project_memory DB 접근
│   │   └── summarizer.py             # 대화 압축 + 요약 생성
│   └── requirements.txt
│
├── building-agent/                   # Python (Building Agent)
│   ├── orchestrator.py               # 메인 엔트리포인트 (NestJS가 spawn)
│   ├── hermes_layer.py               # Gemini: PHASES.md 동적 생성 + QA 감독
│   ├── claude_layer.py               # phase별 Claude Code CLI spawn
│   ├── qa.py                         # npm install + health check
│   └── requirements.txt
│
├── projects/                         # 빌드된 프로젝트들 (gitignore)
│   ├── {project-id-1}/
│   │   ├── PRD.md
│   │   ├── DESIGN.md
│   │   ├── PHASES.md
│   │   ├── handoff.json
│   │   ├── data/
│   │   │   └── app.db                # 프로젝트 전용 SQLite
│   │   └── src/
│   └── {project-id-2}/
│       └── ...
│
├── docker/
│   ├── docker-compose.yml            # orchestrator + planning-agent + nginx
│   └── nginx.conf
│
├── .env.example
├── .gitignore
└── README.md
```

---

## 13. Docker Compose & 프로젝트 격리

모든 사용자 프로젝트는 개별 Docker 컨테이너에서 격리 실행된다. 포트 범위 3000~3999.

```yaml
version: '3.8'

services:
  orchestrator:
    build:
      context: ./orchestrator
    ports:
      - "4000:4000"
    environment:
      - DATABASE_PATH=/data/ax_builder.db
      - GEMINI_API_KEY=${GEMINI_API_KEY}
      - JWT_SECRET=${JWT_SECRET}
      - PLANNING_AGENT_URL=ws://planning-agent:8000/ws
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./projects:/projects
      - db_data:/data
    depends_on:
      - planning-agent

  planning-agent:
    build:
      context: ./planning-agent
    ports:
      - "8000:8000"
    environment:
      - LLM_BACKEND=${LLM_BACKEND:-openai_compat}
      - SLOT_CHAT=${SLOT_CHAT:-gemini-3-flash-preview}
      - SLOT_SUMMARIZE=${SLOT_SUMMARIZE:-gemini-3-flash-preview}
      - SLOT_EVAL=${SLOT_EVAL:-gemini-3-flash-preview}
      - SLOT_TOOL_ARG=${SLOT_TOOL_ARG:-gemini-3-flash-preview}
      - GEMINI_API_KEY=${GEMINI_API_KEY}
      - DATABASE_PATH=/data/ax_builder.db
    volumes:
      - ./projects:/projects
      - db_data:/data

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "3000-3999:3000-3999"
    volumes:
      - ./docker/nginx.conf:/etc/nginx/nginx.conf
    depends_on:
      - orchestrator

volumes:
  db_data:
```

### 13.1 프로젝트별 Docker 컨테이너 규칙

- 각 프로젝트는 `project-{projectId}` 이름의 독립 컨테이너로 실행
- 베이스 이미지: `node:20-slim` (기본)
- 내부 포트 3000 → 호스트 포트 3000~3999 매핑
- 컨테이너 간 네트워크 격리
- 리소스 제한: CPU 0.5 core, Memory 512MB (MVP 기준)
- 프로젝트 삭제 시 컨테이너 + 볼륨 + 데이터 디렉토리 함께 정리

### 13.2 프로젝트 앱 SQLite 격리

각 프로젝트 앱의 데이터 저장은 프로젝트 디렉토리 내 SQLite 파일을 사용한다.

```
/projects/{project-id}/
├── PRD.md
├── DESIGN.md
├── src/
├── data/
│   └── app.db      ← 이 프로젝트 전용 SQLite
└── package.json
```

이점: 격리성, 정리 용이, 인프라 단순화, 백업 용이.

---

## 14. 플랫폼 환경 변수

```env
# .env.example

# LLM 백엔드 (openai_compat | ollama)
LLM_BACKEND=openai_compat

# Gemini API (LLM_BACKEND=openai_compat 시)
GEMINI_API_KEY=AIza...

# LLM Slot 매핑 (역할별 모델. 로컬 전환 시 이 값만 교체)
SLOT_CHAT=gemini-3-flash-preview
SLOT_SUMMARIZE=gemini-3-flash-preview
SLOT_EVAL=gemini-3-flash-preview
SLOT_TOOL_ARG=gemini-3-flash-preview

# Ollama (LLM_BACKEND=ollama 시)
# OLLAMA_HOST=http://localhost:11434
# SLOT_CHAT=qwen3:32b

# Platform Database
DATABASE_PATH=/data/ax_builder.db

# JWT
JWT_SECRET=your_jwt_secret

# Ports
ORCHESTRATOR_PORT=4000
PLANNING_AGENT_PORT=8000
PROJECT_PORT_RANGE_START=3000
PROJECT_PORT_RANGE_END=3999

# AI Gateway (§9.0 / §18 / ADR 0003 — Phase 6 MVP)
# MVP는 orchestrator 내장 (별도 프로세스 없음).
# 생성 앱 컨테이너의 AX_AI_BASE_URL에 주입될 값.
AI_GATEWAY_BASE_URL=http://host.docker.internal:4000/api/ai/v1
# Gateway가 upstream으로 호출할 OpenAI-호환 엔드포인트. 기본 Gemini.
AI_GATEWAY_UPSTREAM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
# 업스트림에 전달할 API 키. 미설정 시 GEMINI_API_KEY로 폴백.
# AI_GATEWAY_UPSTREAM_API_KEY=

# provider 키 (운영자 전용, 생성 앱에는 주입되지 않음)
GEMINI_API_KEY=
# Phase 6.1 추가 예정:
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# AI_GATEWAY_ADMIN_TOKEN=axg_admin_...   # 관리자 API용
```

---

## 15. 구현 우선순위

> **현재 구현 상태 스냅샷 (2026-04-19)**
>
> Phase 1~4 + Phase 5(PR #4 머지) + Phase 6 MVP(PR #5 `feat/ai-gateway-mvp`)까지 반영:
>
> - ✅ **ADR 0001** 관찰 기반 QA — `qa_supervisor.py` 실제 구현 + 검증됨
> - ✅ **ADR 0002** FailureClassifier — regex 룰 1차 분류, env_qa 실패 라우팅, env_attempts 카운터, 프론트 FailureBanner. LLM judge 2차는 Phase 6.1 예정.
> - ✅ **ADR 0003** AI Gateway **MVP** — orchestrator 내장 `/api/ai/v1/*` (OpenAI-호환 chat/completions + SSE). 실제 토큰 발급·해시 인증·upstream Gemini forwarding 작동. E2E 검증(라이어 게임) 완료. `agent-model-mcp` slot-routing 통합은 Phase 6.1.
> - ✅ **ADR 0004** env 3-tier 분류 — 파서/암호화/CRUD/컨테이너 주입, `/api/projects/:id/env` 엔드포인트, 프론트 EnvInput
> - ✅ **ADR 0005** mock-first env 전략 — env 의존 모듈 mock/real 분기 의무화, 빌드 완료 시 env 유무와 무관하게 deployed
> - ✅ **ADR 0006** env 유지보수 UI + 재시작 + 밸리데이션 — 2-모드 EnvInput, `POST /restart`, `.env.example` 메타라인 기반 검증
>
> → LLM을 요구하는 생성 앱이 **실제로 작동**. Phase 6 이전까지는 provider-key 가드 + stub 토큰 조합으로 LLM 호출 불가였지만 이제는 orchestrator Gateway가 실제 응답을 내려준다.

### Phase 1: 코어 (1주)
1. NestJS orchestrator 프로젝트 생성 + SQLite(better-sqlite3) 연결 + 스키마 정의
2. JWT 인증 + 프로젝트 CRUD
3. Planning Agent FastAPI 기본 구조 + LLM slot 추상화
4. Orchestrator ↔ Planning Agent WebSocket 연결
5. React 채팅 UI + completeness 사이드바

### Phase 2: Planning 완성 (1주)
6. Planning Agent 도구 구현 (write_prd, write_design, search_memory, update_memory, evaluate_readiness, propose_handoff)
7. 대화 압축·요약 (session_summaries)
8. handoff.json 생성 + plan_ready 상태 전환
9. "빌드 시작" 버튼 활성화 흐름

### Phase 3: Building 파이프라인 (1주)
10. Building Agent orchestrator.py + Hermes 층 (PHASES.md 동적 생성)
11. Claude Code 층 (phase별 격리 spawn)
12. MVP QA (npm install + health check)
13. bounce-back 흐름 (gap_list → Planning 반송)
14. Docker 컨테이너 생성/관리 (dockerode)

### Phase 4: 프론트엔드 완성 + 안정화 (3~4일)
15. BuildStatus 화면 + WebSocket 실시간 이벤트
16. 프로젝트 대시보드 (권한, 상태, Docker 포트, URL)
17. 수정 요청 플로우 (새 세션 생성, modifying 상태)
18. Nginx 리버스 프록시 설정
19. 에러 핸들링 + Docker Compose 통합 테스트

### Phase 5: QA·Env·Gateway 계약 (현재 PR #4)
20. 관찰 기반 QA (`qa_supervisor.py`) — ADR 0001
21. `.env.example` 3-tier 파서 + AES-256-GCM 암호화 + provider-key 가드 — ADR 0004
22. `awaiting_env` / `env_qa` 상태 + `/api/projects/:id/env` + 프론트 EnvInput — PRD §9·DESIGN.md §4
23. FailureClassifier regex 1차 + env_attempts 카운터 + 프론트 FailureBanner — ADR 0002
24. AI Gateway 계약 확정 (PRD §18·ADR 0003) + system-injected 스텁 — **실체 구현은 Phase 6**

### Phase 6 MVP: AI Gateway 실체 (PR #5 `feat/ai-gateway-mvp`) ✅
25. orchestrator 내장 `/api/ai/v1/*` — OpenAI 호환 chat/completions + SSE 스트리밍
26. `POST /models` 논리 이름(default/cheap/reasoning/fast) 응답 + 토큰 검증
27. `projects.ai_token_hash` 컬럼 + SHA-256 해시 기반 Bearer 인증
28. `envs.service` `syncFromExample`에서 `aiGateway.ensureToken()` idempotent 호출로 stub 제거
29. `env-deploy.restartOnly`가 `.env` 재기록 후 재시작 — DB→파일 동기 보장
30. `AI_GATEWAY_BASE_URL` 기본값 `http://host.docker.internal:4000/api/ai/v1` (Docker Desktop)
31. Gemini OpenAI-compat upstream (`generativelanguage.googleapis.com/v1beta/openai`)
32. E2E 검증: 컨테이너 → Gateway → Gemini → 200 + 실제 응답

### Phase 6.1: 내부 에이전트 통합 + 운영성 (예정)
33. **Planning / Hermes / Claude Code CLI의 Gateway 경유 전환**
    - Planning Agent `openai_compat` 백엔드 기본값을 Gateway로 (`/api/ai/v1`)
    - Hermes `building-agent/llm.py`도 동일 경유
    - Claude Code CLI는 `ANTHROPIC_BASE_URL`로 Gateway(Anthropic passthrough 포함)
    - 플랫폼 전체 LLM 트래픽을 단일 감사 라인으로 통합
34. **사용량·비용 로깅** — 호출마다 `ai_usage_logs` 행 기록 (project_id, model, tokens, cost_est, timestamp)
35. **프로젝트 단위 예산 cap** — 일일/월 한도 초과 시 429 + 저렴 모델 자동 폴백(opt-in)
36. **관리자 대시보드 카드** (DESIGN.md §5.2) — 이번 달 요청수·토큰·예상 비용
37. **Anthropic / OpenAI passthrough 엔드포인트** — `/api/ai/v1/anthropic/messages` 등, tool use/thinking/caching 원본 포맷 중계
38. **`agent-model-mcp` slot-routing backend 통합** — Gateway의 `model: "fast|deep|code|..."` 논리 이름을 MCP stdio의 slot dispatch로 매핑 (로컬 Mac Studio 도입 시 모델 전환 투명화)
39. **FailureClassifier LLM judge 2차** (`qa_judge` 슬롯) — regex 미매칭 로그를 LLM이 분류
40. **기능 단위 QA** — `npm install + health`를 넘어 생성 앱의 주요 엔드포인트 curl 검증 (PRD에 정의한 핵심 유저 플로우별)

---

## 16. 사전 준비

### 16.1 사전 준비 (수동, 1회)

```bash
# 1. Claude Code CLI 설치 + 로그인
npm install -g @anthropic-ai/claude-code
claude login

# 2. Python 의존성
cd planning-agent && pip install -r requirements.txt
cd building-agent && pip install -r requirements.txt

# 3. 정상 작동 확인
claude -p "Hello, are you working?" --output-format stream-json
python building-agent/orchestrator.py --health-check
```

### 16.2 이 PRD를 Claude Code에게 전달할 때

```
1. 이 PRD와 ARCHITECTURE.md를 읽고 전체 구조를 파악하세요.
2. Phase 1 → Phase 4 순서로 구현하세요.
3. 각 Phase가 끝날 때마다 테스트를 실행하여 정상 작동을 확인하세요.
4. Backend 디렉토리는 orchestrator/ 입니다. backend/ 를 생성하지 마세요.
5. DB는 better-sqlite3 (SQLite)를 사용하세요. MySQL/PostgreSQL 의존 금지.
6. Planning Agent는 planning-agent/, Building Agent는 building-agent/ 에 구현하세요.
7. Orchestrator는 TypeScript strict 모드, Agent들은 Python 3.11+로 작성하세요.
8. Docker Compose로 orchestrator + planning-agent + nginx를 통합 실행하세요.
9. 환경 변수는 .env.example을 기반으로 .env 파일을 만드세요.
```

---

## 17. 성공 기준

- 비개발자가 아이디어를 텍스트로 입력하면, Planning Agent와 대화를 거쳐 PRD/DESIGN.md가 확정된다.
- 확정된 PRD로 "빌드 시작" 버튼을 누르면, 실제 접속 가능한 URL이 생성된다.
- QA를 통과하지 못하면 즉시 Planning으로 반송하고, 유저에게 실패 이유를 명확히 표시한다.
- 배포된 서비스에 대한 수정 요청도 동일 구조(새 세션 → PRD 업데이트 → 재빌드)로 처리된다.
- 여러 사용자가 동시에 각자의 프로젝트를 독립적으로 관리할 수 있다.
- **LLM 기능만 필요한 앱은 유저 입력 env가 0개**. 빌드 종료 직후 바로 `deployed`.
- **QA 실패 원인이 유저 책임(env 값 오류)인 경우 기획으로 반송되지 않는다** — FailureClassifier가 분류하여 env 재입력 UI만 노출.

---

## 18. AI Gateway API 스펙

§9.0에 정의한 게이트웨이의 인터페이스 계약. **MVP는 orchestrator 내장**(`orchestrator/src/ai-gateway/`) — 별도 `agent-model-mcp` 프로세스는 Phase 6.1에서 backend 통합 고려.

### 18.1 MVP — OpenAI 호환 HTTP (현재 구현)

**베이스 URL**: `{AI_GATEWAY_BASE_URL}` (기본 `http://host.docker.internal:4000/api/ai/v1`)
**인증**: `Authorization: Bearer {AX_AI_TOKEN}` — 프로젝트당 1개, `axt_<48hex>` 형태

| 메소드 | 경로 | 상태 |
|---|---|---|
| POST | `/chat/completions` | ✅ OpenAI-호환 body 통과. `stream: true` 시 SSE pass-through. |
| POST | `/models` | ✅ 토큰 유효성 + 논리 모델 이름 리스트 (현재 `default`/`cheap`/`reasoning`/`fast`) |
| POST | `/embeddings` | ⏳ Phase 6.1 |
| POST | `/anthropic/messages` (passthrough) | ⏳ Phase 6.1 |
| POST | `/gemini/{model}:generateContent` (passthrough) | ⏳ Phase 6.1 |

**모델 이름 매핑** (MVP, 전부 Gemini OpenAI-compat)
| 논리 이름 | 실제 모델 |
|---|---|
| `default` / `cheap` / `fast` | `gemini-2.5-flash` |
| `reasoning` | `gemini-2.5-pro` |

모르는 이름은 그대로 upstream으로 전달 (실제 모델명 직접 지정도 허용).

**인증 실패 응답**
```json
{"message": "토큰이 존재하지 않거나 폐기됨", "error": "Unauthorized", "statusCode": 401}
```

**구현 위치**
- `orchestrator/src/ai-gateway/ai-gateway.controller.ts`
- `orchestrator/src/ai-gateway/ai-gateway.service.ts` — `mintToken` / `resolveToken` / `forwardChatCompletion` / `normalizeModel`
- 토큰 저장: 평문은 `project_env_vars.AX_AI_TOKEN`(AES-256-GCM), 해시는 `projects.ai_token_hash`(SHA-256)

### 18.2 Phase 6.1 확장 (예정)

#### 18.2.1 추가 엔드포인트

| 메소드 | 경로 | 용도 |
|---|---|---|
| POST | `/embeddings` | OpenAI-compat 임베딩 |
| POST | `/anthropic/messages` | Anthropic Messages API 원본 (tool use, thinking, caching) |
| POST | `/gemini/{model}:generateContent` | Gemini 원본 |

#### 18.2.2 관리 API (admin 토큰)

| 메소드 | 경로 | 용도 |
|---|---|---|
| POST | `/admin/tokens` | `{project_id, daily_limit, monthly_limit, allowed_models[]}`로 토큰 수동 발급 |
| DELETE | `/admin/tokens/:project_id` | 토큰 revoke (`ai_token_hash`를 NULL로) |
| GET | `/admin/usage?project_id=&from=&to=` | 프로젝트 사용량 조회 |
| POST | `/admin/models` | 논리 이름 ↔ 실제 모델 매핑 갱신 |

#### 18.2.3 요금·속도 제한

- 403: 모델이 토큰 스코프 밖
- 429: `daily_limit` / `monthly_limit` / RPS 초과. 응답 본문에 `retry_after_seconds` 포함.
- 토큰별 RPS 기본 20.

#### 18.2.4 `agent-model-mcp` backend 통합

Gateway의 `model: "fast|orchestrator|deep|code|longtext"` 논리 이름을 MCP stdio의 `model_ask` 도구로 디스패치. `agent-model-mcp` 리포의 slot 라우팅(OpenRouter ↔ Ollama 전환)을 그대로 활용. 로컬 Mac Studio 도입 시 클라우드→로컬 전환 투명화.

### 18.3 장애 대응

- 게이트웨이 `/healthz` 주기 ping (Phase 6.1 추가 예정). 실패 시 프론트 "AI 기능 일시 중단" 배너.
- 생성 앱 SDK 래퍼 예시 스니펫(mock-first fallback 포함)을 Claude Code 프롬프트에 주입 — ADR 0005 참조.

