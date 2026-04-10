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

## 어떻게 작동하나요?

| 단계 | 무슨 일이 일어나는지 | 사용하는 AI |
|---|---|---|
| **Discovery** | AI가 린 캔버스 기반으로 질문하며 아이디어를 PRD로 구조화 | Gemini 3.0 Flash |
| **Build** | PRD를 기반으로 코드 생성 + 서버 실행 | Hermes Agent → Claude Code CLI |
| **QA** | 가상 브라우저로 접속하여 모든 기능을 자동 검증 | Claude Code CLI (에이전트 팀) |
| **Fix** | QA 실패 시 자동 수정 후 재검증 | Hermes Agent → Claude Code CLI |
| **Deploy** | Docker 컨테이너에 격리 배포, URL 발급 | Docker + Nginx |

모든 프로젝트는 개별 Docker 컨테이너에서 격리 실행됩니다. 한 프로젝트가 망가져도 다른 프로젝트에 영향 없습니다.

---

## 설치

### 요구사항

- Node.js 20+
- Python 3.11+
- Docker + Docker Compose
- Gemini API 키 ([Google AI Studio](https://aistudio.google.com/)에서 발급)
- Anthropic 계정 (Claude Code CLI 로그인용)

### 1단계: 프로젝트 받기

```bash
git clone https://github.com/sangwoon/ax-builder.git
cd ax-builder
```

### 2단계: 자동 설치

```bash
chmod +x setup.sh
./setup.sh
```

setup.sh가 아래를 자동으로 처리합니다:
- Node.js 의존성 설치 (frontend + backend)
- Claude Code CLI 설치
- Hermes Agent 설치 (Python)
- Docker 이미지 다운로드
- `.env` 파일 생성

### 3단계: 수동 설정 (1회)

```bash
# 1. API 키 입력
nano .env
# GEMINI_API_KEY, JWT_SECRET, DB_ROOT_PASSWORD 입력

# 2. Claude Code 로그인
claude login
```

### 4단계: 실행

```bash
# Docker 서비스 시작 (MySQL, Nginx)
docker-compose up -d

# 백엔드 시작
cd backend && npm run start:dev

# 프론트엔드 시작 (별도 터미널)
cd frontend && npm run dev
```

http://localhost:5173 에서 접속 가능합니다.

---

## 사용법

### 새 프로젝트 만들기

1. 메인 페이지에서 **[+ 새 프로젝트]** 클릭
2. 프로젝트 이름 입력
3. AI와 대화하며 아이디어 구체화
4. 스코어가 900점 이상이 되면 **[제작]** 버튼 활성화
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
- 팀 단위 일괄 공유는 의도적으로 지원하지 않음 (한 사람의 문제를 해결하는 인스턴트 제품 철학)

---

## 스코어링 기준

AI는 대화를 통해 아이디어를 1000점 만점으로 평가합니다.

| 구간 | 상태 | 의미 |
|---|---|---|
| 0~499 | 🔴 모호함 | 문제 자체가 불명확. 더 많은 대화 필요 |
| 500~699 | 🟠 문제 정리됨 | 문제는 파악됐으나 해결 방법 미정 |
| 700~899 | 🟡 프로세스 완료 | 기능까지 정리됐으나 세부사항 부족 |
| 900~1000 | 🟢 제작 가능 | UI/UX까지 설계 완료. 빌드 가능 |

평가 항목 (각 200점):
- 문제 정의 / 기능 목록 / 사용 흐름 / 기술 실현성 / 사용자 경험

---

## 기술 스택

| 레이어 | 기술 |
|---|---|
| Frontend | React + TypeScript + Tailwind CSS |
| Backend | NestJS + TypeScript |
| Database | MySQL (플랫폼) + SQLite (프로젝트별) |
| Discovery Agent | Gemini 3.0 Flash |
| Build/QA 오케스트레이터 | Hermes Agent |
| Build/QA 실행 | Claude Code CLI |
| 컨테이너 격리 | Docker (포트 3000~3999) |
| 리버스 프록시 | Nginx |

---

## 프로젝트 구조

```
ax-builder/
├── frontend/          # React 웹 UI
├── backend/           # NestJS API 서버
├── bridge/            # Hermes Agent ↔ Claude Code CLI 브릿지
│   └── hermes_pipeline.py
├── projects/          # 빌드된 프로젝트들 (자동 생성)
├── docker/            # Docker Compose + Nginx 설정
├── setup.sh           # 자동 설치 스크립트
├── .env.example       # 환경 변수 템플릿
└── README.md
```

---

## 환경 변수

| 변수 | 설명 | 예시 |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini API 키 | `AIza...` |
| `DB_ROOT_PASSWORD` | MySQL 루트 비밀번호 | `your_password` |
| `JWT_SECRET` | JWT 인증 시크릿 | `your_secret` |
| `OPENROUTER_API_KEY` | Hermes Agent용 (선택) | `sk-or-...` |

Claude Code CLI는 `claude login`으로 인증하며, 환경 변수 불필요.

---

## FAQ

**Q: 코딩을 전혀 몰라도 쓸 수 있나요?**
네. AI와 대화만 하면 됩니다. 코드를 볼 일도 없습니다.

**Q: 만든 앱은 어디서 접속하나요?**
프로젝트 대시보드에 접속 URL이 표시됩니다. `http://localhost:3000~3999` 범위의 포트가 자동 할당됩니다.

**Q: 동시에 몇 개까지 만들 수 있나요?**
포트 범위(3000~3999) 내에서 최대 1000개까지 동시 운영 가능합니다.

**Q: 앱 데이터는 어디에 저장되나요?**
각 프로젝트 폴더 안에 SQLite 파일로 저장됩니다. 프로젝트 삭제 시 데이터도 함께 삭제됩니다.

**Q: 다른 사람이 내 앱을 수정할 수 있나요?**
본인이 명시적으로 editor 권한을 부여한 사람만 수정 가능합니다.

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
