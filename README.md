# ax-builder

**비개발자가 아이디어를 말하면, AI가 작동하는 제품을 만들어주는 플랫폼**

---

## 이게 뭔가요?

ChatGPT나 Claude한테 "앱 만들어줘"라고 하면, `.html` 파일 하나 받고 끝나본 적 있으시죠?

ax-builder는 그 문제를 해결합니다.

1. **아이디어를 말하면** → AI가 빈틈을 찾아 질문합니다
2. **기획이 완성되면** → AI가 코드를 짜고, 서버를 띄우고, 테스트까지 합니다
3. **접속 URL을 받으면** → 진짜 작동하는 웹앱이 나옵니다

개발 지식 없어도 됩니다. 코드도 안 봐도 됩니다.

---

## 데모

```
👤 "팀 점심 메뉴 투표 앱이 필요해요. 매일 후보를 올리고 투표하는 거요."

🤖 "좋은 시작이에요. 몇 가지 확인할게요.
    1. 투표는 익명인가요, 실명인가요?
    2. 후보는 누구나 올릴 수 있나요?"

    ... (대화 5~10번) ...

🤖 "스코어 920/1000 — 제작 가능합니다! [제작] 버튼을 눌러주세요."

    ... (AI가 빌드 + QA 자동 진행) ...

✅ "완료! http://localhost:3017 에서 확인하세요."
```

---

## 빠른 시작 (3단계)

### 요구사항

- Node.js 20+
- Python 3.11+ (`brew install python@3.11`)
- **Docker** (빌드된 프로젝트 컨테이너 격리 실행용 — **필수**)
- [Gemini API 키](https://aistudio.google.com/) (무료 발급 가능)
- [Google OAuth 클라이언트](https://console.cloud.google.com) (로그인용)
- Claude Pro/Team 구독 + `claude` CLI (phase 실행을 정액제 OAuth 크레딧으로 사용)
- pm2 (권장: `npm i -g pm2`) — 4개 프로세스(orchestrator/planning-agent/frontend/hermes-mcp)를 한 번에 관리

### 1단계: .env 설정

```bash
git clone https://github.com/kei781/ax-builder.git
cd ax-builder
cp .env.example .env
nano .env
```

아래 값을 입력하세요:

| 변수 | 어디서 발급하나요 |
|---|---|
| `GOOGLE_CLIENT_ID` | [Google Cloud Console](https://console.cloud.google.com) → API 및 서비스 → 사용자 인증 정보 → OAuth 2.0 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | 위와 동일 (승인된 리디렉션 URI: `http://localhost:4000/api/auth/google/callback`) |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/) → API 키 발급 |
| `JWT_SECRET` | 아무 랜덤 문자열 (예: `openssl rand -hex 32`) |
| `ALLOWED_EMAIL_DOMAIN` | 로그인 허용할 이메일 도메인 (예: `cv-3.com`) |

### 2단계: 설치

```bash
chmod +x setup.sh
./setup.sh
```

setup.sh가 자동으로 처리하는 것:
- `orchestrator` + `frontend` Node.js 의존성 설치
- `planning-agent` + `building-agent` Python venv·의존성 설치
- `.env` 파일 생성 (없을 경우)
- `data/`, `projects/` 디렉토리 생성

### 3단계: 실행

pm2로 4개 프로세스를 한 번에 기동:

```bash
npx pm2 start ecosystem.config.cjs
npx pm2 logs  # 로그 스트림 확인
```

| 프로세스 | 역할 | 포트 |
|---|---|---|
| `ax-orchestrator` | NestJS API + WebSocket + AI Gateway | 4000 |
| `ax-planning-agent` | Planning LLM Socket.IO 서버 (Python) | 4100 |
| `ax-frontend` | Vite dev 서버 | 5173 |
| 배포된 프로젝트 | Docker 컨테이너 | 3000~3999 중 자동 할당 |

http://localhost:5173 에서 접속. 끝.

> DB 서버를 따로 띄울 필요 없습니다. SQLite를 사용하며 `data/ax-builder.db` 파일로 자동 생성됩니다.

### 최초 1회 추가 설정

```bash
# Claude Code CLI 로그인 (정액제 구독 크레딧으로 phase 실행)
claude auth login
```

---

## 사용법

### 새 프로젝트 만들기

1. 메인 페이지에서 **[+ 새 프로젝트]** 클릭
2. 프로젝트 이름 입력
3. AI와 대화하며 아이디어 구체화
4. 스코어 600점 이상(모든 항목 최소 60%)에서 **[빌드 시작]** 또는 **[AI에게 핸드오프 요청]** 버튼 활성화 (최적 구간은 850점 이상 = "충분 조건 충족")
5. 제작 버튼 클릭 → AI가 빌드 + QA 자동 진행
6. 완료되면 접속 URL 확인

### 기존 프로젝트 수정하기

1. 프로젝트 카드에서 **[버그 리포트]** 또는 **[서비스 개선]** 클릭
2. 수정 요구사항을 대화로 입력
3. AI가 PRD를 먼저 업데이트한 뒤, 코드를 PRD에 맞춰 수정
4. QA 통과 후 자동 반영

### 프로젝트 권한

- 만든 사람(owner)만 수정/삭제 가능
- 다른 사람에게 editor(수정 가능) 또는 viewer(보기만 가능) 권한 부여 가능

---

## 어떻게 작동하나요?

| 단계 | 무슨 일이 일어나는지 | 사용하는 AI |
|---|---|---|
| **Discovery** | AI가 린 캔버스 기반으로 질문하며 아이디어를 PRD로 구조화 | Gemini 3 Flash |
| **Build** | PRD를 기반으로 코드 생성 + 서버 실행 | Hermes Agent → Claude Code CLI |
| **QA** | 브라우저로 접속하여 모든 기능을 자동 검증 | Claude Code CLI |
| **Fix** | QA 실패 시 자동 수정 후 재검증 (최대 3회) | Hermes Agent → Claude Code CLI |
| **Deploy** | Docker 컨테이너에 격리 배포, URL 발급 | Docker |

> Hermes Agent는 오케스트레이터 역할만 하고, 실제 코딩은 모두 Claude Code CLI가 수행합니다.

---

## 스코어링 기준

AI는 대화를 통해 아이디어를 1000점 만점으로 평가합니다.

| 구간 | 상태 | 의미 |
|---|---|---|
| 0~499 | 🔴 모호함 | 문제 자체가 불명확. 더 많은 대화 필요 |
| 500~699 | 🟠 문제 정리됨 | 문제는 파악됐으나 해결 방법 미정 |
| 600~849 | 🟡 최소 조건 충족 | 핸드오프 요청 가능하나 "보강 권장"으로 거부될 수 있음 |
| 850~1000 | 🟢 충분 조건 충족 | UI/UX까지 설계 완료. 빌드 권장 |

평가 항목 (각 200점):
- 문제 정의 / 기능 목록 / 사용 흐름 / 기술 실현성 / 사용자 경험

---

## 기술 스택

| 레이어 | 기술 |
|---|---|
| Frontend | React + TypeScript + Tailwind CSS |
| Backend | NestJS + TypeScript |
| Database | SQLite (better-sqlite3) |
| Discovery Agent | Gemini 3 Flash |
| Build/QA 오케스트레이터 | Hermes Agent |
| Build/QA 실행 | Claude Code CLI |
| 컨테이너 격리 | Docker (포트 3000~3999) |

---

## 프로젝트 구조

```
ax-builder/
├── frontend/           # React + Vite 웹 UI
├── orchestrator/       # NestJS API + WebSocket + AI Gateway
├── planning-agent/     # Python FastAPI + Socket.IO (기획 대화 LLM 루프)
├── building-agent/     # Python Hermes — phase 계획·Claude Code 호출
├── docs/
│   ├── adr/            # 설계 결정 기록 (0001~0009)
│   └── ops/            # 트러블슈팅 회고
├── data/               # SQLite DB (자동 생성)
├── projects/           # 빌드된 프로젝트들 (자동 생성)
├── docker/             # MySQL compose
├── ecosystem.config.cjs # pm2 설정
├── setup.sh
├── .env.example
└── README.md
```

---

## 환경 변수

| 변수 | 설명 | 필수 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth 클라이언트 ID | ✅ |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 시크릿 | ✅ |
| `GEMINI_API_KEY` | Gemini API 키 | ✅ |
| `JWT_SECRET` | JWT 인증 시크릿 | ✅ |
| `ALLOWED_EMAIL_DOMAIN` | 허용 이메일 도메인 | ✅ |
| `HERMES_PYTHON_PATH` | Hermes Agent Python 경로 (setup.sh가 자동 설정) | 자동 |
| `OPENROUTER_API_KEY` | Hermes Agent용 LLM API 키 | 선택 |
| `GEMINI_MODEL` | Gemini 모델명 (기본: gemini-3-flash-preview) | 선택 |
| `DB_PATH` | SQLite DB 경로 (기본: data/ax-builder.db) | 선택 |

---

## FAQ

**Q: 코딩을 전혀 몰라도 쓸 수 있나요?**
네. AI와 대화만 하면 됩니다. 코드를 볼 일도 없습니다.

**Q: 만든 앱은 어디서 접속하나요?**
프로젝트 대시보드에 접속 URL이 표시됩니다. `http://localhost:3000~3999` 범위의 포트가 자동 할당됩니다.

**Q: DB 서버를 따로 설치해야 하나요?**
아닙니다. SQLite를 사용하며 `data/ax-builder.db` 파일로 자동 생성됩니다. 별도 DB 서버가 필요 없습니다.

**Q: 앱 데이터는 어디에 저장되나요?**
각 프로젝트 폴더 안에 SQLite 파일로 저장됩니다. 프로젝트 삭제 시 데이터도 함께 삭제됩니다.

**Q: QA에서 계속 실패하면?**
AI가 자동으로 최대 3회 수정을 시도합니다. 그래도 해결 안 되면 실패 리포트와 함께 PRD 수정을 안내합니다.

---

## 철학

> "2022년의 개발자 연봉은 '경쟁'의 결과였고, 2025년의 연봉은 '가치'의 결과입니다."

AI가 코드를 짜는 시대에, 진짜 가치는 **"뭘 만들 것인가"를 판단하는 능력**에 있습니다.

ax-builder는 비개발자가 그 판단을 직접 실행에 옮길 수 있게 해주는 도구입니다. 코드는 AI가 짜면 됩니다. 중요한 건 **어떤 문제를 해결할 것인가**입니다.

---

## 라이선스

MIT

---

## 만든 사람

노상운 — 비즈니스의 병목을 기술로 해결하는 프로덕트 엔지니어

- Email: kei781@naver.com
- LinkedIn: [linkedin.com/in/kei781](https://www.linkedin.com/in/kei781)
