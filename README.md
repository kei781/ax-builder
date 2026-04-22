# ax-builder

**비개발자가 아이디어를 말하면, AI가 작동하는 제품을 만들고 계속 운영·수정해주는 플랫폼**

---

## 이게 뭔가요?

ChatGPT나 Claude에 "앱 만들어줘"라고 하면 `.html` 파일 하나 받고 끝나본 적 있으시죠? ax-builder는 그 문제를 해결합니다.

1. **아이디어를 말하면** → AI가 빈틈을 찾아 질문하며 PRD를 구조화
2. **기획이 완성되면** → AI가 코드 작성 → QA → 배포까지 자동
3. **접속 URL을 받으면** → 진짜 작동하는 웹앱이 나옵니다
4. **쓰다가 수정이 필요하면** → "수정 요청" 한 번으로 배포 중인 앱에 **업데이트 사이클** 시작. 기존 버전은 계속 운영되면서 새 버전이 뒤에서 준비됨.

개발 지식 없어도 됩니다. 코드도 안 봐도 됩니다.

---

## 데모

```
👤 "팀 점심 메뉴 투표 앱이 필요해요. 매일 후보를 올리고 투표하는 거요."

🤖 "좋은 시작이에요. 몇 가지 확인할게요.
    1. 투표는 익명인가요, 실명인가요?
    2. 후보는 누구나 올릴 수 있나요?"

    ... (대화 5~10번) ...

🤖 스코어 860/1000 · 최소 조건 충족 — [빌드 시작] 버튼 활성화

    ... (Hermes가 phase 단위로 Claude Code 호출 → 파일 생성 → QA) ...

✅ "완료! http://localhost:3017 에서 확인하세요."

👤 (며칠 뒤) "투표 마감 시간 설정 기능 추가해줘"

🤖 ↻ 업데이트 사이클 시작 — 이전 기획 대화는 PRD에 반영된 상태.
    현재 PRD를 읽고 어디에 넣을지 제안합니다 ...
    (updating 중에도 기존 버전은 3017 포트에서 계속 운영)
```

---

## 빠른 시작

### 요구사항

- **Node.js 20+** (NVM 권장)
- **Python 3.11+** (`brew install python@3.11`)
- **Docker** (빌드된 프로젝트 컨테이너 격리 실행 — **필수**)
- [Gemini API 키](https://aistudio.google.com/) (Planning Agent·phase_planner용, 무료 발급)
- [Google OAuth 클라이언트](https://console.cloud.google.com) (유저 로그인)
- Claude Pro/Team 구독 + `claude` CLI — phase 실행을 **정액제 OAuth 크레딧**으로 사용 (ADR 0009)
- pm2 (권장: `npm i -g pm2`) — 4개 프로세스 통합 관리

### 1단계: 클론 + .env

```bash
git clone https://github.com/kei781/ax-builder.git
cd ax-builder
cp .env.example .env
```

주요 값 (전체는 §환경 변수 참조):

| 변수 | 값 | 발급 |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth 자격 증명 | Google Cloud Console. 리디렉션: `http://localhost:4000/api/auth/google/callback` |
| `GEMINI_API_KEY` | Gemini API 키 | https://aistudio.google.com/ |
| `JWT_SECRET` | 랜덤 문자열 | `openssl rand -hex 32` |
| `ALLOWED_EMAIL_DOMAIN` | 로그인 허용 도메인 | 본인이 결정 (예: `cv-3.com`) |
| `ADMIN_EMAILS` | (선택) 플랫폼 관리자 이메일 | 본인 이메일 — 모든 프로젝트 접근 가능 |

### 2단계: 설치

```bash
./setup.sh
```

자동 수행:
- `orchestrator` + `frontend` Node.js 의존성 설치
- `planning-agent` + `building-agent` Python venv·의존성 설치
- `data/`, `projects/`, `docker/mysql/` 디렉토리 생성

### 3단계: 실행

pm2로 4개 프로세스를 한 번에 기동:

```bash
npx pm2 start ecosystem.config.cjs
npx pm2 logs  # 로그 스트림 확인
```

| 프로세스 | 역할 | 포트 |
|---|---|---|
| `ax-orchestrator` | NestJS API + WebSocket + AI Gateway | 4000 |
| `ax-planning-agent` | Planning LLM Socket.IO 서버 | 4100 |
| `ax-frontend` | Vite dev 서버 | 5173 |
| 배포된 프로젝트 | Docker 컨테이너 | 3000~3999 중 자동 할당 (3000/5000/8000/8080 블랙리스트) |

http://localhost:5173 에서 접속.

### 최초 1회

```bash
claude auth login   # Claude Code CLI OAuth 로그인 (정액제 크레딧 사용)
```

---

## 사용법

### 새 프로젝트 만들기 (첫 빌드 라인)

1. 대시보드 → **[+ 새 프로젝트]**
2. AI와 대화하며 PRD 구조화 — 5개 항목(문제 정의·기능 목록·사용 흐름·기술 실현성·사용자 경험) 자체 평가
3. 스코어 600점(모든 항목 ≥ 60%) 이상 → **[AI에게 핸드오프 요청]** 또는 **[빌드 시작]** 활성화
4. 빌드 진행 화면 — phase별 실시간 status, `write_prd`/`propose_handoff` tool 호출 관찰
5. QA 통과 → Docker 컨테이너 기동 → URL 발급

### 배포된 앱 수정 (업데이트 라인, ADR 0008)

1. deployed 상태 프로젝트 카드 → **[수정 요청]** (또는 채팅창에 바로 메시지)
2. **새 세션 자동 시작** — 이전 planning 대화는 PRD·DESIGN에 반영됐다는 전제로 빈 컨텍스트
3. 업데이트 에이전트가 기존 PRD 읽고 **실현 가능성 평가** → 가능하면 문서 업데이트 → `propose_handoff`
4. **[업데이트 시작]** → Building Agent가 기존 컨테이너 유지한 채 새 컨테이너를 다른 포트에 띄움
5. 헬스체크 + regression 검증 (이전 버전의 `primary_endpoints`가 여전히 응답하는지) → 통과 시 이전 컨테이너 제거
6. **실패 시 이전 버전 자동 유지** (ADR 0008 §D4 핵심 불변식 — 유저 앱은 다운 없음)

업데이트 대화가 잘못된 방향이라고 판단되면 header 우측 **[↩ 업데이트 취소]** → PRD·DESIGN까지 백업에서 복원 → deployed 복귀 (§D4-bis).

### 실패 처리 (retry-first, ADR 0008 §7.6)

- 빌드 phase 실패 → `failed` 상태. UI 실패 배너에 **[↻ 다시 빌드]** (primary) + **[기획 대화로]** (보조)
- 2회 연속 실패 시 primary/secondary 플립 — 반복 실패는 기획 이슈 시그널
- `infra_error` (Claude CLI 인증 만료, OOM 등) → "관리자 문의" 전용 배너. retry 의미 없음.

### 프로젝트 권한

- **owner**: 프로젝트 생성자. 수정·삭제·멤버 관리
- **editor**: owner가 초대. 수정 가능, 삭제 불가
- **viewer**: 로그인한 모든 유저 기본값. 읽기만
- **admin**: `ADMIN_EMAILS` 포함 이메일. 모든 프로젝트 owner 권한 접근 (운영·디버깅용)

---

## 아키텍처

### 3-tier 에이전트

```
┌────────────────────────────────────────────────┐
│  Frontend (React)                              │
└───────────────────┬────────────────────────────┘
                    │ HTTP + WebSocket
┌───────────────────▼────────────────────────────┐
│  Orchestrator (NestJS, port 4000)              │
│  - 상태 머신 / 권한 / env / 빌드 lifecycle     │
│  - AI Gateway (생성 앱에 OpenAI-호환 제공)     │
└──┬─────────────────┬───────────────────────────┘
   │ Socket.IO       │ subprocess
┌──▼──────────────┐  ┌──▼──────────────────────────┐
│ Planning Agent  │  │ Building Agent (Hermes)     │
│ Python+Gemini   │  │ Python + Claude Code CLI    │
│                 │  │  stream-json protocol       │
│ 유저와 대화→PRD │  │  phase 단위 자율 코딩       │
└─────────────────┘  └──┬──────────────────────────┘
                        │ phase당 Claude CLI 프로세스
                        │ --input-format stream-json
                        ▼
                     Claude Code CLI
                     (Opus 4.7 @ effort max, OAuth 구독)
```

### 주요 흐름

| 단계 | 에이전트 | LLM | 비고 |
|---|---|---|---|
| Discovery | Planning Agent | Gemini 2.5 Flash | `write_prd`·`evaluate_readiness`·`propose_handoff` tool 루프 |
| Phase 계획 | Hermes (phase_planner) | Gemini | PHASES.md 생성 |
| Phase 실행 | Hermes → Claude Code | **Opus 4.7 @ effort max** (정액제) | Read/Write/Edit/Bash/Glob/Grep 자율 tool loop (ADR 0009 stream-json) |
| QA (ADR 0001) | Hermes | - | 관찰 기반: `npm install` + `npm start` + 포트 관찰 + HTTP HEAD + primary_endpoints probe |
| 실패 분류 (ADR 0002) | FailureClassifier | - (regex) | env_rejected / transient / code_bug / infra_error / schema_bug |
| 배포 | env-deploy | - | Docker createContainer + 헬스체크 + 롤백 |

### 상태 머신 (두 라인 분리, ADR 0008)

```
[첫 빌드 라인]
draft → planning → plan_ready → building → qa → env_qa → deployed
                ↑                      │
                └── bounce-back ───────┘

[업데이트 라인]
deployed → planning_update → update_ready → updating → update_qa → deployed (v+1)
              ▲                                  │
              └── 실패 시 previous 복구 ────────┘
```

상세: [ADR 0008](docs/adr/0008-update-state-line-separation.md)

---

## 핵심 원칙 (ADR 요약)

| # | 결정 | 상세 |
|---|---|---|
| [0001](docs/adr/0001-observation-based-qa.md) | 관찰 기반 QA | LLM이 PORT env 안 지켜도 OS 수준에서 바인드된 포트 관찰 |
| [0002](docs/adr/0002-failure-classifier.md) | FailureClassifier | env_qa 실패를 regex로 분류해 유저/AI/운영자 중 책임 주체 라우팅 |
| [0003](docs/adr/0003-ai-gateway-contract.md) | AI Gateway 계약 | 생성 앱이 플랫폼 토큰(`AX_AI_TOKEN`)으로 Claude API 사용 |
| [0005](docs/adr/0005-mock-first-env.md) | mock-first env | env 값 없어도 빌드·배포 진행. `hasEnv ? real : mock` 분기 강제 |
| [0006](docs/adr/0006-env-maintenance.md) | 유지보수 2-모드 UI | setup / maintenance 모드 + 인라인 밸리데이션 + 재시작 |
| [0007](docs/adr/0007-ai-gateway-mvp.md) | Phase 6 MVP | orchestrator 내장 OpenAI-호환 엔드포인트 |
| [0008](docs/adr/0008-update-state-line-separation.md) | 업데이트 상태 라인 분리 | deployed 앱 수정을 별도 세션·프롬프트·color로 격리 |
| [0009](docs/adr/0009-claude-code-mcp-serve.md) | Claude Code를 Hermes 도구로 | subprocess `--print` → `--input-format stream-json` 전환 |

전체: [docs/adr/](docs/adr/) · 운영 회고: [docs/ops/](docs/ops/)

---

## 프로젝트 구조

```
ax-builder/
├── frontend/           # React + Vite + Tailwind
├── orchestrator/       # NestJS — REST + WS + AI Gateway
│   ├── src/
│   │   ├── agents/     # building.runner.ts (Hermes spawn)
│   │   ├── ai-gateway/ # OpenAI-호환 엔드포인트 (ADR 0007)
│   │   ├── auth/       # Google OAuth + admin (ADMIN_EMAILS)
│   │   ├── build/ | chat/ | envs/ | handoffs/ | projects/
│   │   ├── state-machine/
│   │   └── websocket/
│   └── scripts/        # migrate-adr-0008.mjs 등
├── planning-agent/     # Python FastAPI + Socket.IO (기획 대화)
│   └── app/agent/      # loop.py, tools/, system_prompt.py
├── building-agent/     # Python Hermes
│   ├── orchestrator.py # phase 관리 (ADR 0001·0008·0009)
│   ├── phase_planner.py
│   ├── phase_runner.py # stream-json Claude Code 호출
│   └── qa_supervisor.py
├── docs/
│   ├── adr/            # 설계 결정 기록 (0001~0009)
│   └── ops/            # 운영 회고
├── data/               # SQLite (자동 생성)
├── projects/           # 빌드된 앱 소스 (자동 생성)
├── docker/             # MySQL compose
├── ecosystem.config.cjs # pm2 설정 (CLAUDE_CODE_OAUTH_TOKEN 오버라이드 포함)
├── setup.sh
└── .env.example
```

---

## 환경 변수 (전체)

| 변수 | 용도 | 기본값 |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth 로그인 | — |
| `ALLOWED_EMAIL_DOMAIN` | 로그인 허용 도메인 | — |
| `GEMINI_API_KEY` / `OPENAI_COMPAT_API_KEY` | Planning·phase_planner LLM | — |
| `GEMINI_MODEL` / `OPENAI_COMPAT_MODEL` | 모델 지정 | `gemini-2.5-flash-preview` |
| `JWT_SECRET` | JWT 서명 | `default_secret` (교체 필수) |
| `ADMIN_EMAILS` | 플랫폼 관리자 이메일 (`,` 구분) | (empty) |
| `CLAUDE_CODE_MODEL` | phase 실행 Claude 모델 | `claude-opus-4-7` |
| `CLAUDE_CODE_EFFORT` | Claude effort (low/medium/high/max) | `max` |
| `CLAUDE_PHASE_TIMEOUT_S` | phase 단위 timeout | `900` (15분) |
| `PROJECT_PORT_RANGE_START` / `_END` | 배포 앱 호스트 포트 범위 | `3000` / `3999` |
| `VITE_PROJECT_HOST` | 프론트가 표시할 배포 앱 호스트 | `localhost` |
| `DB_PATH` | SQLite 경로 | `data/ax-builder.db` |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | 가입 승인 알림 메일 | (선택) |

블랙리스트 포트(3000/5000/8000/8080 + 4000·4100·5173·5174)는 자동 제외 — 앱 하드코딩 포트와 충돌 방지 (회고 §7).

---

## 스코어링

Planning Agent가 대화 중 5개 항목(각 0.0~1.0, 합산 1000점 환산) 자체 평가:

| 항목 | 평가 기준 |
|---|---|
| problem_definition | 해결하려는 문제가 구체적인가 |
| feature_list | 핵심 기능이 명시됐는가 |
| user_flow | 사용자가 어떤 순서로 기능을 쓰는지 명확한가 |
| feasibility | 단일 웹앱으로 구현 가능한 범위인가 |
| user_experience | 화면·상호작용이 어느 정도 그려지는가 |

UI 3단계 (DESIGN §5.1.2):
- **충분 조건** (모든 항목 ≥ 0.85): 🟢 "충분 조건 충족"
- **최소 조건** (모든 항목 ≥ 0.6, unresolved 0): 🟡 "최소 조건 충족 (보강 권장)"
- 그 외: 🔴 "보강 필요"

`propose_handoff`는 최소 조건 이상일 때 accepted. 실제 빌드 버튼은 `plan_ready` 상태에서 활성화.

---

## FAQ

**Q: Claude 구독 없이도 쓸 수 있나요?**
현재 구조는 Claude Code CLI의 OAuth 구독 크레딧을 쓰도록 설계됨 (phase 실행). `ANTHROPIC_API_KEY` + `--bare` 모드로 API key 전환도 가능하지만 사용량 과금. ADR 0009 참조.

**Q: QA가 브라우저로 E2E 테스트하나요?**
아닙니다. ADR 0001 관찰 기반 QA — `npm start` 후 바인드된 포트를 lsof로 탐지, HTTP HEAD 응답 확인. 업데이트 라인에선 추가로 소스 스캔한 primary_endpoints 전부 probe (§D7).

**Q: 빌드가 같은 이유로 계속 실패하면?**
retry-first 정책. 1회 실패엔 "↻ 다시 빌드"가 primary, 2회 연속 실패부터 "기획 대화로"가 primary로 플립. `infra_error`는 retry 의미 없고 "관리자 문의" 배너만.

**Q: 업데이트 중 기존 앱은 다운되나요?**
아닙니다. ADR 0008 §D4 불변식 — 새 컨테이너 헬스체크 성공까지 이전 컨테이너 유지. 실패 시 새 컨테이너만 제거, 이전 그대로 운영. 수정 대화가 잘못됐다 싶으면 "↩ 업데이트 취소"로 PRD·DESIGN까지 이전 상태로 롤백(§D4-bis).

**Q: Planning Agent가 "도구 호출했습니다"라고 말만 하고 실제로 안 하면?**
orchestrator가 이 환각 패턴을 감지해 UI에 경고 배너 + 재시도 유도 (회고 §6, 구현 커밋 579a26d). 프롬프트·UI·백엔드 3단 방어.

**Q: orchestrator 재시작하면 진행 중인 빌드는?**
`onModuleInit` sweep이 `building`/`qa`/`updating`/`update_qa` 상태 프로젝트를 전수 감지해 `failed`로 복구 + 컨테이너 정리. "↻ 다시 빌드" 한 번으로 이어감 (회고 §5).

**Q: DB 서버 따로 필요한가요?**
orchestrator 메타데이터용 **MySQL**이 `docker-compose`로 기동됩니다 (setup.sh가 처리). 사용자 앱 각각은 내장 **SQLite**를 쓰므로 추가 DB 불필요.

---

## 참고 문서

- [PRD.md](PRD.md) — 제품 요구사항 (상태 머신·데이터 모델·API 스펙·로드맵)
- [ARCHITECTURE.md](ARCHITECTURE.md) — 시스템 설계 상세
- [DESIGN.md](DESIGN.md) — UI/UX 사양
- [docs/adr/](docs/adr/) — 9개 ADR (설계 결정 기록)
- [docs/ops/](docs/ops/) — 트러블슈팅 회고

---

## 철학

> "2022년의 개발자 연봉은 '경쟁'의 결과였고, 2025년의 연봉은 '가치'의 결과입니다."

AI가 코드를 짜는 시대에, 진짜 가치는 **"뭘 만들 것인가"를 판단하는 능력**에 있습니다. ax-builder는 비개발자가 그 판단을 직접 실행에 옮길 수 있게 해주는 도구입니다. 코드는 AI가 짜면 됩니다. 중요한 건 **어떤 문제를 해결할 것인가**입니다.

---

## 라이선스

MIT

---

## 만든 사람

노상운 — 비즈니스의 병목을 기술로 해결하는 프로덕트 엔지니어

- Email: kei781@naver.com
- LinkedIn: [linkedin.com/in/kei781](https://www.linkedin.com/in/kei781)
