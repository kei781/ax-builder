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
| 컨테이너 격리 | Docker | 프로젝트별 격리, 포트 관리 |
| 리버스 프록시 | Nginx | 포트 라우팅, 도메인 매핑 |

---

## 3. 시스템 아키텍처

### 3.1 3-tier 구조

```
┌─────────────────────────────────────────────────────────────┐
│ NestJS Orchestrator                                          │
│  - UI 서빙 / 인증 / 권한 검증                                 │
│  - 프로젝트 상태 머신 소유                                    │
│  - 에이전트 프로세스 생명주기 관리 (spawn/timeout/cleanup)    │
│  - WebSocket 이벤트 허브                                      │
│  - DB 소유자 (SQLite, better-sqlite3)                        │
└─────────────────────┬────────────────────┬──────────────────┘
                      │                    │
                      ▼                    ▼
┌──────────────────────────────┐  ┌──────────────────────────────┐
│ Planning Agent (FastAPI)      │  │ Building Agent (Python)       │
│  - 유저와 대화 (스트리밍)      │  │  - PRD/DESIGN → PHASES.md     │
│  - PRD.md / DESIGN.md 생성    │  │  - phase별 Claude Code 위임   │
│  - handoff.json 생성          │  │  - QA 감독 / bounce-back 판단 │
│  - OpenAI 호환 API            │  │  Hermes(Gemini) + Claude Code │
└──────────────────────────────┘  └──────────────────────────────┘
```

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
  status TEXT DEFAULT 'draft',
  -- status: 'draft' | 'planning' | 'plan_ready' | 'building' | 'qa' | 'deployed' | 'failed' | 'modifying'
  port INTEGER DEFAULT NULL,
  container_id TEXT DEFAULT NULL,
  project_path TEXT DEFAULT NULL,
  git_remote TEXT DEFAULT NULL,
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
POST   /api/projects/:id/restart            → 서비스 재시작 (owner, editor)
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
  - phase_end:        { phase_name: string, status: 'success' | 'failed' }
  - build_complete:   { success: boolean, url: string, port: number }
  - build_failed:     { phase: string, reason: string, gap_list: string[] }
  - qa_result:        { passed: boolean, details: object }
```

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
- 외부 API 키는 환경변수로 처리, .env.example 반드시 생성
- package.json scripts에 "start" 커맨드 반드시 포함
- 내부 포트는 PORT 환경변수 우선, 기본값 3000
```

---

## 8. QA 및 수정 루프

### 8.1 MVP QA 흐름

```
Building Agent (orchestrator.py)
  ├── phase 완료
  ├── npm install 실행
  ├── npm start (백그라운드)
  ├── curl http://localhost:{port}/health (최대 30초 대기)
  │     → 200 응답: QA pass → 다음 phase 또는 deployed
  │     → 타임아웃/에러: QA fail → 즉시 Planning 반송
  └── gap_list 구성 + handoff bounce_back 기록
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

---

## 9. 환경 변수(ENV) 관리

### 9.1 플로우

Building Agent가 생성한 앱에 외부 API 키가 필요한 경우 `.env.example`이 생성된다.

```
빌드 완료 (deployed)
  → .env.example 파싱
  → ENV 필요 여부 판단
    → 불필요: 그대로 운영
    → 필요: 프론트엔드에 ENV 입력 안내
      → 유저가 ENV 값 입력
      → .env 파일 생성 + 컨테이너 재시작
      → health check 재실행
        → 통과: 정상 운영
        → 실패: ENV 문제 분석 + 재입력 안내 또는 롤백
```

### 9.2 .env.example 규격

```
# [변수명]
# 설명: 이 변수가 왜 필요한지 (비개발자도 이해 가능하게)
# 발급 방법: 단계별 안내
# 예시: 실제 형식 예시 (가짜 값)
# 필수 여부: required / optional
VARIABLE_NAME=
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

### 10.1 상태 머신

```
draft ──> planning ──> plan_ready ──> building ──> qa ──> deployed
               ↑                         │
               └─────── bounce-back ─────┘
                                                              │
                                                              └─> modifying (새 세션)
```

| 상태 | 의미 |
|---|---|
| `draft` | 프로젝트 생성 직후, Planning 시작 전 |
| `planning` | Planning Agent와 대화 중 |
| `plan_ready` | 완성도 충분, 유저의 "빌드 시작" 대기 |
| `building` | Building Agent 실행 중 |
| `qa` | QA phase 진행 중 (UI 표시용 세부 상태) |
| `deployed` | 컨테이너 기동 완료, 접속 가능 |
| `failed` | 해결 불가 상태 |
| `modifying` | deployed 이후 수정 요청으로 새 세션 진입 |

### 10.2 전환 트리거

| 전환 | 트리거 |
|---|---|
| `draft → planning` | 유저 첫 메시지 입력 |
| `planning → plan_ready` | Planning Agent `propose_handoff` + 유저 UI 확인 |
| `plan_ready → building` | **유저가 "빌드 시작" 버튼 클릭** (수동 승인) |
| `building → planning` | Building의 bounce-back (자동) |
| `building → qa → deployed` | Building 자체 진행 (자동) |
| `deployed → modifying` | 유저 수정 요청 (새 세션 생성) |

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
```

---

## 15. 구현 우선순위

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
