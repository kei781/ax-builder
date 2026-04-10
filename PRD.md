# PRD: AI Product Builder Platform

> **비개발자가 아이디어를 제품으로 만들 수 있는 AI 네이티브 플랫폼**
> Discovery Agent(Gemini)가 기획의 빈틈을 채우고, Hermes Agent가 Claude Code CLI를 활용하여 코드를 생성·검증·배포한다.

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
- **Discovery Agent (문제 구조화)**: 린 캔버스, 유저 스토리 맵 등 프레임워크를 활용하여 모호한 불편함을 "기술적으로 해결 가능한 문제"로 쪼개고, PRD를 생성하며, 기준점 통과 시에만 빌드를 허용
- **Execution Agent (지속적 구현)**: 확정된 PRD를 기반으로 코드를 자동 생성. 수정 시에도 PRD를 먼저 업데이트하고, 전체 코드를 PRD에 맞춰 재정렬하는 자기 참조적(Self-referential) 개발
- **QA Agent**: 런타임 검증 + PRD 기반 기능 검증. UX 검증은 제외 — 그건 사용자 본인이 직접 피드백
- **비개발자 친화적 UI**: AI가 뭘 하고 있는지, 진척도가 어디인지, 완성도가 몇 %인지 사용자가 항상 인지할 수 있어야 함

---

## 2. 기술 스택

| 레이어 | 기술 | 이유 |
|---|---|---|
| Frontend | React + TypeScript + Tailwind CSS | 빠른 UI 구성, 채팅 인터페이스 |
| Backend | NestJS + TypeScript | 구조적 강제성, 기존 스킬셋 활용 |
| Database | MySQL | 세션, 프로젝트, 사용자 데이터 |
| Scoring Agent | Google Gemini 3.0 Flash API 직접 호출 | 도구 불필요, 빠른 응답, 저비용 |
| Builder/QA 오케스트레이터 | Hermes Agent (Python library) | 에이전트 루프, 재시도, 컨텍스트 관리, 도구 디스패치 |
| Builder/QA 실행 | Claude Code CLI (Hermes가 호출) | 최고 품질의 코드 생성, 빠른 속도, 사전 설치+로그인 완료 |
| 컨테이너 격리 | Docker | 프로젝트별 격리, 포트 관리 |
| 리버스 프록시 | Nginx | 포트 라우팅, 도메인 매핑 |

---

## 3. 시스템 아키텍처

### 3.1 전체 플로우

```
[User] → [Web UI] → [NestJS API] → [Scoring Agent] → 스코어 통과?
                                                          ↓ YES
                                    [NestJS: mkdir + PRD 저장 + git init]
                                                          ↓
                                    [Docker 컨테이너 생성]
                                                          ↓
                                    [Hermes Agent → Claude Code CLI: 코드 생성]
                                                          ↓
                                    [Hermes Agent → Claude Code CLI: QA 검증]
                                                          ↓ PASS
                                    [포트 할당 + 배포]
                                                          ↓
                                    [대시보드에 프로젝트 등록]
```

### 3.2 세션 관리

Discovery Agent(Gemini)의 대화 세션은 NestJS 백엔드 DB에서 관리한다.
Builder/QA(Hermes)는 PRD를 기준으로 실행하되, 같은 프로젝트 수정 시 이전 맥락을 활용할 수 있다.

```
Discovery Agent (Gemini):
  매 요청마다:
  1. DB에서 user_id + project_id 기준으로 conversation_history 로드
  2. Gemini API에 history 포함하여 호출
  3. 응답 수신 후 updated conversation_history를 DB에 저장

Builder/QA Agent (Hermes → Claude Code CLI):
  1. NestJS가 Python Bridge를 통해 Hermes AIAgent 호출
  2. Hermes가 Claude Code CLI를 터미널 도구로 실행
  3. Hermes의 에이전트 루프가 재시도, 에러 감지, 전략 변경을 자동 관리
  4. 결과를 NestJS에 반환
```

---

## 4. 데이터 모델

### 4.1 Users

```sql
CREATE TABLE users (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 4.2 Projects

```sql
CREATE TABLE projects (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status ENUM('scoring', 'building', 'qa', 'awaiting_env', 'deployed', 'failed', 'stopped') DEFAULT 'scoring',
  score INT DEFAULT 0,
  port INT DEFAULT NULL,
  container_id VARCHAR(100) DEFAULT NULL,
  prd_path VARCHAR(500) DEFAULT NULL,
  project_path VARCHAR(500) DEFAULT NULL,
  git_remote VARCHAR(500) DEFAULT NULL,
  build_attempts INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 4.3 Conversations (세션 저장)

```sql
CREATE TABLE conversations (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  type ENUM('scoring', 'bug_report', 'improvement') NOT NULL,
  conversation_history JSON NOT NULL,
  current_score INT DEFAULT 0,
  score_tier VARCHAR(30) DEFAULT 'too_vague',
  score_passed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 4.4 Build Logs

```sql
CREATE TABLE build_logs (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36) NOT NULL,
  attempt INT NOT NULL,
  phase ENUM('build', 'qa', 'deploy') NOT NULL,
  status ENUM('running', 'success', 'failed') NOT NULL,
  log_output TEXT,
  error_message TEXT,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP DEFAULT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
```

### 4.5 Project Permissions (프로젝트 권한)

프로젝트는 생성자만 수정 가능하다. 팀 단위 공유는 허용하지 않는다.
생성자가 명시적으로 허용한 사용자만 수정 권한을 가진다.

```sql
CREATE TABLE project_permissions (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  role ENUM('owner', 'editor', 'viewer') NOT NULL DEFAULT 'viewer',
  granted_by VARCHAR(36) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (granted_by) REFERENCES users(id),
  UNIQUE KEY unique_project_user (project_id, user_id)
);
```

권한 규칙:
- owner: 프로젝트 생성자. 수정, 삭제, 권한 부여 가능. 자동 생성됨.
- editor: owner가 명시적으로 부여. 수정 가능, 삭제/권한 부여 불가.
- viewer: 접속 URL만 확인 가능. 수정 불가.
- 팀 단위 일괄 공유는 지원하지 않음. 반드시 개인 단위로 권한 부여.

---

## 5. API 명세

### 5.1 인증

```
POST /api/auth/register     { email, name, password }
POST /api/auth/login         { email, password }
```

MVP에서는 간단한 JWT 인증으로 구현한다.

### 5.2 프로젝트

```
GET    /api/projects                    → 내 프로젝트 리스트 (owner + editor + viewer 전부)
POST   /api/projects                    → 새 프로젝트 생성 { title }
GET    /api/projects/:id                → 프로젝트 상세 (status, port, score 등)
DELETE /api/projects/:id                → 프로젝트 삭제 (owner만 가능)
POST   /api/projects/:id/stop          → 서비스 중지 (owner, editor)
POST   /api/projects/:id/restart       → 서비스 재시작 (owner, editor)
```

### 5.2.1 프로젝트 권한

```
GET    /api/projects/:id/permissions              → 권한 목록 (owner만)
POST   /api/projects/:id/permissions              → 권한 부여 { user_email, role } (owner만)
DELETE /api/projects/:id/permissions/:user_id     → 권한 회수 (owner만)
```

모든 프로젝트 수정 API(chat, build, stop, restart)에는 권한 가드가 적용된다.
viewer는 프로젝트 상세 조회와 접속 URL 확인만 가능하다.

### 5.3 스코어링 채팅 (Discovery + 수정 공통)

```
POST /api/projects/:id/chat
  Request:  { message: string, type: "scoring" | "bug_report" | "improvement" }
  Response: {
    reply: string,
    current_phase: string,
    score: number,
    score_tier: string,
    score_label: string,
    score_passed: boolean,
    breakdown: { problem_definition, feature_list, user_flow, feasibility, user_experience },
    missing_items: string[],
    prd_preview: string | null
  }
```

### 5.4 자기 참조적 수정 플로우 (Self-referential Development)

버그 리포트 / 서비스 개선 시, 코드를 직접 수정하지 않는다.
PRD를 먼저 업데이트하고, Builder Agent가 PRD를 기준으로 코드를 재정렬한다.

```
1. 사용자가 bug_report 또는 improvement 타입으로 채팅
2. Discovery Agent가 수정 요구사항을 구조화 + 스코어링
3. 스코어 통과 시 → 기존 prd.md를 업데이트 (diff 생성)
4. Builder Agent에게 "업데이트된 PRD를 읽고, 기존 코드를 PRD에 맞춰 수정하라" 지시
5. QA Agent가 재검증
```

이 구조의 핵심: Builder Agent는 항상 PRD만 참조한다. 사용자의 자연어 요청이
직접 코드에 반영되지 않고, PRD라는 중간 계층을 반드시 거친다.

### 5.4 빌드

```
POST /api/projects/:id/build          → 빌드 시작 (score >= 900일 때만)
GET  /api/projects/:id/build/status   → 빌드 진행 상태
GET  /api/projects/:id/build/logs     → 빌드 로그
```

### 5.6 WebSocket (실시간 상태 — UX 투명성)

```
ws://host/ws/projects/:id
  Events:
    - build_progress: {
        phase: "setup" | "coding" | "qa" | "deploy",
        current_task: "사용자 입력 폼 컴포넌트 생성 중",  // 자연어 설명
        files_created: 4,
        files_total: 12,      // 추정치
        elapsed_seconds: 151,
        progress_percent: 35
      }
    - build_complete: { success, url, port }
    - build_failed: { error, attempt, max_attempts, fix_suggestion }
    - qa_result: { passed, features_tested, features_passed, features_failed }
    - prd_updated: { diff_summary }  // 수정 플로우에서 PRD 변경 시
```

---

## 6. Scoring Agent 상세

### 6.1 호출 방식

Google Gemini 3.0 Flash API를 NestJS에서 직접 호출한다. Claude Code CLI는 사용하지 않는다.
도구가 필요 없는 순수 대화이므로, 빠르고 저렴한 Flash 모델을 사용한다.

```typescript
// scoring.service.ts 핵심 로직
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function scorePRD(conversationHistory: Message[], userMessage: string) {
  const response = await ai.models.generateContent({
    model: 'gemini-3.0-flash',
    config: {
      systemInstruction: SCORING_SYSTEM_PROMPT,
      maxOutputTokens: 4096,
    },
    contents: [
      ...conversationHistory.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      { role: 'user', parts: [{ text: userMessage }] },
    ],
  });
  return response;
}
```

### 6.2 시스템 프롬프트 (Discovery Agent)

```
당신은 비개발자의 모호한 불편함을 "기술적으로 해결 가능한 문제"로 구조화하는
Discovery Agent입니다. 단순한 PRD 평가가 아니라, 사용자의 문제를 함께 쪼개는
과정을 진행합니다.

## 대화 단계

### 1단계: 문제 발견 (Lean Canvas 기반)
아래 질문을 자연스러운 대화로 하나씩 풀어가세요:
- "어떤 상황에서 불편함을 느끼시나요?" (Problem)
- "지금은 어떻게 해결하고 계세요?" (Existing Alternatives)
- "이게 해결되면 어떤 상태가 되면 좋겠어요?" (Value Proposition)
- "이걸 주로 누가 쓰게 될까요? 본인만? 팀?" (Customer Segments)

### 2단계: 기능 구조화 (User Story Map 기반)
문제가 파악되면, 유저 스토리로 전환하세요:
- "그러면 [사용자]가 [목표]를 달성하려면, 먼저 뭘 해야 하나요?"
- "그 다음은요?"
- 각 단계를 "~할 수 있다" 형태의 기능으로 정리

### 3단계: 기술적 실현 가능성 검증
- 외부 API가 필요한지, 데이터 저장이 필요한지 확인
- 데이터 저장이 필요하면 SQLite를 사용할 것임을 안내 (사용자에게는 "앱 안에 데이터가 자동 저장됩니다" 정도로 설명)
- 단일 웹앱으로 구현 가능한 범위로 스코프를 조절
- 비개발자 용어로 기술적 제약을 설명

## 스코어링 기준 (각 항목 0~200점, 총 1000점)

1. **문제 정의** (200점): 누구의 어떤 불편함인지 구체적인가?
2. **기능 목록** (200점): 유저 스토리가 빠짐없이 정의되었는가?
3. **사용 흐름** (200점): 첫 접속 → 목표 달성까지의 경로가 있는가?
4. **기술 실현성** (200점): 단일 웹앱으로 구현 가능한 범위인가?
5. **사용자 경험** (200점): UI/UX 흐름, 에러 처리, 온보딩이 설계되었는가?

### 스코어 구간별 의미

| 구간 | 상태 | 의미 | UI 표시 |
|---|---|---|---|
| 0~499 | 🔴 모호함 | 문제 자체가 지나치게 모호함. 더 많은 대화 필요 | "아직 문제를 더 구체화해야 해요" |
| 500~699 | 🟠 문제 정리됨 | 문제는 파악됐으나 해결 프로세스가 미정립 | "문제는 이해했어요. 이제 어떻게 해결할지 정리해볼까요?" |
| 700~899 | 🟡 프로세스 완료 | 기능과 흐름까지 정리됐으나, 구현하기엔 부족 | "거의 다 왔어요! 세부사항 몇 가지만 더 채우면 돼요" |
| 900~1000 | 🟢 제작 가능 | UI/UX까지 충분히 설계됨. 빌드 가능 | [제작] 버튼 활성화 |

## 응답 형식

항상 아래 JSON 구조를 응답 마지막에 포함하세요:

\`\`\`json
{
  "current_phase": "discovery" | "structuring" | "validation",
  "score": 650,
  "score_tier": "process_incomplete",
  "breakdown": {
    "problem_definition": 160,
    "feature_list": 130,
    "user_flow": 120,
    "feasibility": 140,
    "user_experience": 100
  },
  "missing_items": [
    "데이터를 새로고침해도 유지할지 결정 필요",
    "에러 발생 시 사용자에게 보여줄 메시지 미정"
  ],
  "passed": false,
  "prd_preview": null
}
\`\`\`

## 규칙
- 점수가 900점 이상이면 passed: true
- score_tier: "too_vague"(~499) | "problem_defined"(500~699) | "process_complete"(700~899) | "ready_to_build"(900~)
- current_phase를 항상 표시하여 사용자가 지금 어느 단계인지 알게 함
- 대화 초반에는 점수를 낮게 주되, 구체적으로 뭘 보완하면 점수가 오를지 안내
- 비개발자도 이해할 수 있는 용어만 사용. 전문 용어 사용 시 반드시 쉬운 설명 병기
- 한 번에 질문은 최대 2개까지
- passed가 true가 되면, 최종 PRD를 마크다운으로 정리하여 prd_preview에 포함
- "프로세스화가 불가능하다"고 느끼는 사용자도 있으므로, 작은 단위로 쪼개서 질문
```

### 6.3 스코어 파싱

NestJS에서 응답을 받은 후, JSON 블록을 파싱하여 score, score_tier, missing_items, passed를 추출한다.

```typescript
// 스코어 구간 판정
function getScoreTier(score: number) {
  if (score >= 900) return { tier: 'ready_to_build', label: '🟢 제작 가능', passed: true };
  if (score >= 700) return { tier: 'process_complete', label: '🟡 프로세스 완료 — 세부사항 보완 필요', passed: false };
  if (score >= 500) return { tier: 'problem_defined', label: '🟠 문제 정리됨 — 프로세스 미정립', passed: false };
  return { tier: 'too_vague', label: '🔴 지나치게 모호함', passed: false };
}
```

passed === true (900점 이상)이면 프론트엔드에 "제작" 버튼을 활성화한다.

---

## 7. Builder Agent 상세 (Hermes → Claude Code CLI)

### 7.1 구조

```
NestJS 백엔드
  → Python Bridge (child_process.spawn)
    → Hermes AIAgent (오케스트레이터)
      → Claude Code CLI (터미널 도구로 실행)
```

Hermes가 에이전트 루프(재시도, 에러 감지, 전략 변경)를 관리하고,
실제 코드 생성은 Claude Code CLI에게 위임한다.

### 7.2 사전 준비

```bash
# 1. Claude Code CLI 설치 + 로그인 (수동, 1회)
npm install -g @anthropic-ai/claude-code
claude login

# 2. Hermes Agent 설치
pip install git+https://github.com/NousResearch/hermes-agent.git
```

### 7.3 Python Bridge

```
/bridge/
  hermes_pipeline.py   ← 빌드 + QA + 수정 통합
  requirements.txt
```

프롬프트 및 코드 상세는 8.2절 참조.

### 7.4 NestJS에서 호출

```typescript
// build.service.ts
import { spawn } from 'child_process';

async function runHermesPipeline(projectPath: string, port: number): Promise<PipelineResult> {
  return new Promise((resolve, reject) => {
    const args = JSON.stringify({ project_path: projectPath, port });
    const proc = spawn('python', ['bridge/hermes_pipeline.py', args], {
      cwd: process.cwd(),
    });

    let output = '';
    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      output += chunk;
      // WebSocket으로 실시간 전달
      this.wsGateway.emitProgress(projectId, chunk);
    });

    proc.on('close', (code) => {
      resolve(JSON.parse(output));
    });
  });
}
```

---

## 8. QA 및 수정 루프 (Hermes 에이전트 루프 내부)

### 8.1 구조

빌드 → QA → 수정 → QA → ... 전체를 **하나의 Hermes 에이전트 세션**에서 처리한다.
Hermes가 Claude Code CLI를 단계별로 호출하며, QA 실패 시 자연스럽게 수정 단계로 이어진다.

```
NestJS → Python Bridge → Hermes AIAgent (단일 세션)
  ├── 1. Claude Code CLI: 코드 생성 (빌드)
  ├── 2. Claude Code CLI: 브라우저로 QA (에이전트 팀 + Browser 도구)
  ├── 3. QA 실패? → Claude Code CLI: 코드 수정
  ├── 4. Claude Code CLI: 브라우저로 QA 재실행
  └── ... (Hermes가 pass될 때까지 반복)
```

### 8.2 Builder + QA 통합 프롬프트

```python
# hermes_pipeline.py — 통합 프롬프트
PIPELINE_PROMPT = """
당신은 프로젝트 빌더이자 QA 엔지니어입니다.
Claude Code CLI(`claude` 명령)를 사용하여 코드를 생성하고, 검증하고, 수정합니다.

## 전체 파이프라인

### STEP 1: 빌드
claude -p "prd.md를 읽고 이 디렉토리에 웹앱을 구현하세요. [규칙]" --allowedTools Bash,Read,Write,Edit

### STEP 2: QA
빌드가 끝나면, Claude Code CLI 에이전트 팀에 Browser 도구를 활성화하여 QA를 수행하세요:
claude -p "prd.md를 읽고, http://localhost:{port} 에 브라우저로 접속하여 모든 기능을 검증하세요. 
버튼 클릭, 폼 입력, 페이지 이동 등 실제 사용자 행동으로 테스트하세요.
결과를 JSON으로 보고하세요." --allowedTools Bash,Read,Browser

### STEP 3: 수정 (QA 실패 시)
QA에서 실패한 항목이 있으면, 해당 fix_suggestions를 기반으로 Claude Code CLI로 수정하세요:
claude -p "prd.md를 다시 읽고, 아래 QA 실패 항목을 수정하세요: [실패 항목]" --allowedTools Bash,Read,Write,Edit

### STEP 4: QA 재실행
수정 후 STEP 2를 다시 실행하세요.
QA가 통과될 때까지 STEP 2~3을 반복하세요.

## 빌드 규칙
- 데이터 저장이 필요하면 반드시 SQLite 사용 (./data/app.db)
- MySQL, PostgreSQL 등 외부 DB 의존 금지
- 가능하면 최소한의 파일 구조
- README.md에 실행 방법 기록
- 외부 API 키는 환경변수로 처리하고, .env.example 파일을 반드시 생성하세요.
  각 변수에 대해 아래 형식으로 주석을 작성하세요:
  # [변수명]
  # 설명: 이 변수가 왜 필요한지 (비개발자도 이해 가능하게)
  # 발급 방법: 이 값을 어디서 구하는지 단계별 안내
  # 예시: 실제 형식 예시 (가짜 값)
  # 필수 여부: required / optional
  VARIABLE_NAME=

## QA 보고 형식
{
  "health_check": true/false,
  "console_errors": [],
  "features_tested": ["할일 추가", "할일 완료 체크", "할일 삭제"],
  "features_passed": ["할일 추가", "할일 완료 체크"],
  "features_failed": [
    {"name": "할일 삭제", "reason": "삭제 버튼 클릭 시 반응 없음"}
  ],
  "overall_pass": false,
  "fix_suggestions": ["삭제 버튼의 onClick 핸들러가 바인딩되지 않은 것으로 보임"]
}
"""

def run_pipeline(project_path: str, port: int):
    agent = AIAgent(
        model="anthropic/claude-sonnet-4",
        quiet_mode=True,
        ephemeral_system_prompt=PIPELINE_PROMPT.replace("{port}", str(port)),
        skip_memory=True,
        max_iterations=90,
    )

    result = agent.run_conversation(
        user_message=f"프로젝트 경로 {project_path}, 포트 {port}. prd.md를 읽고 빌드 → QA → 수정을 완료하세요.",
        task_id=f"pipeline-{project_path.split('/')[-1]}",
    )

    return {
        "success": True,
        "final_response": result["final_response"],
    }

if __name__ == "__main__":
    import sys, json
    args = json.loads(sys.argv[1])
    result = run_pipeline(**args)
    print(json.dumps(result))
```

### 8.3 NestJS에서의 파이프라인 관리

Hermes 에이전트 루프 안에서 빌드→QA→수정이 자체적으로 반복된다.
NestJS는 전체 파이프라인의 성공/실패만 관리한다.

```typescript
// build.service.ts
async function runBuildPipeline(projectId: string) {
  const project = await this.projectRepo.findOne(projectId);

  // Hermes가 빌드 + QA + 수정을 한 세션에서 처리
  const result = await this.runHermesPipeline(project.projectPath, project.port);

  if (result.success) {
    await this.projectRepo.update(projectId, { status: 'deployed' });
  } else {
    // Hermes 내부에서 반복 시도해도 해결 안 된 경우
    await this.projectRepo.update(projectId, {
      status: 'failed',
      build_attempts: project.build_attempts + 1,
    });
  }
}
```

### 8.4 왜 하나의 Hermes 세션인가

- 빌드한 직후에 QA를 하면, **방금 생성한 코드의 컨텍스트가 남아있어** 수정이 정확함
- QA 실패 → 수정 → 재QA가 대화 흐름 안에서 자연스럽게 이어짐
- Hermes 에이전트 루프가 "아직 QA를 통과하지 못했다"는 판단을 자체적으로 하고, Claude Code CLI를 반복 호출함
- NestJS가 각 단계를 개별 호출하면, 매번 컨텍스트를 새로 로드해야 하고 비효율적

---

## 9. 환경 변수(ENV) 관리

### 9.1 플로우

빌드 과정에서 Builder Agent가 `.env.example` 파일을 생성한다.
이 파일에는 제품 실행에 필요한 환경 변수의 키와 설명이 포함된다.

```
빌드 완료
  → .env.example 파싱
  → ENV 입력 필요 여부 판단
    → 필요 없음 (.env.example 없거나 비어있음) → 바로 배포
    → 필요함 → status = 'awaiting_env'
      → 프론트엔드에 ENV 입력 화면 표시
      → 최초 제작자가 모든 ENV 값 입력
      → .env 파일 생성 → 컨테이너 재시작
      → QA 재실행
        → 통과 → 배포
        → 실패 → ENV 관련 문제인지 판단 → 재입력 요청
```

### 9.2 .env.example 규격

Builder Agent의 빌드 규칙에 아래를 추가한다:

```
.env.example 파일을 생성할 때, 각 환경 변수에 대해 아래 형식으로 주석을 작성하세요:

# [변수명]
# 설명: 이 변수가 왜 필요한지 비개발자도 이해할 수 있게
# 발급 방법: 이 값을 어디서 어떻게 구할 수 있는지 단계별로 안내
# 예시: 실제 형식이 어떻게 생겼는지 (가짜 값으로)
# 필수 여부: required / optional
VARIABLE_NAME=

예시:
# [OPENAI_API_KEY]
# 설명: AI 기능에 사용되는 OpenAI API 키입니다.
# 발급 방법:
#   1. https://platform.openai.com 에 접속하세요.
#   2. 회원가입 또는 로그인하세요.
#   3. 좌측 메뉴에서 "API Keys"를 클릭하세요.
#   4. "Create new secret key"를 클릭하세요.
#   5. 생성된 키를 복사하여 아래에 붙여넣으세요.
# 예시: sk-proj-abc123def456...
# 필수 여부: required
OPENAI_API_KEY=
```

### 9.3 데이터 모델

```sql
CREATE TABLE project_env_vars (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(36) NOT NULL,
  key_name VARCHAR(255) NOT NULL,
  encrypted_value TEXT,              -- AES-256 암호화 저장
  description TEXT,                  -- .env.example에서 파싱한 설명
  how_to_obtain TEXT,                -- 발급 방법 안내
  example_value VARCHAR(500),        -- 예시 값
  is_required BOOLEAN DEFAULT TRUE,
  is_filled BOOLEAN DEFAULT FALSE,
  version INT DEFAULT 1,             -- 롤백용 버전 관리
  previous_encrypted_value TEXT,     -- 직전 값 (롤백용)
  updated_by VARCHAR(36),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  UNIQUE KEY unique_project_key (project_id, key_name)
);
```

### 9.4 API

```
GET    /api/projects/:id/env                → ENV 목록 (owner, editor만)
PUT    /api/projects/:id/env                → ENV 일괄 저장 { vars: [{key, value}] }
GET    /api/projects/:id/env/guide          → ENV별 발급 가이드 (설명 + 발급 방법)
POST   /api/projects/:id/env/rollback       → 이전 ENV로 롤백 + 프로세스 재시작
```

viewer는 ENV에 접근 불가. owner/editor만 조회·수정 가능.
ENV 값은 DB에 AES-256으로 암호화 저장하며, API 응답에서도 마스킹 처리 (앞 4자리만 표시).

### 9.5 ENV 입력 화면

```
┌─────────────────────────────────────────────────┐
│  Todo App — 환경 변수 설정                          │
│                                                   │
│  ⚠️ 이 제품을 실행하려면 아래 정보가 필요합니다.       │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │ 🔑 OPENAI_API_KEY              [필수]        │  │
│  │                                               │  │
│  │ AI 기능에 사용되는 OpenAI API 키입니다.          │  │
│  │                                               │  │
│  │ 📋 발급 방법:                                   │  │
│  │  1. https://platform.openai.com 에 접속       │  │
│  │  2. 회원가입 또는 로그인                         │  │
│  │  3. 좌측 메뉴 → "API Keys"                     │  │
│  │  4. "Create new secret key" 클릭               │  │
│  │  5. 생성된 키를 아래에 붙여넣기                   │  │
│  │                                               │  │
│  │ 예시: sk-proj-abc123def456...                  │  │
│  │                                               │  │
│  │ [sk-proj-________________________]    [붙여넣기] │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │ 🔑 WEATHER_API_KEY             [선택]        │  │
│  │                                               │  │
│  │ 날씨 정보를 가져오는 API 키입니다.               │  │
│  │ 입력하지 않으면 날씨 기능이 비활성화됩니다.        │  │
│  │                                               │  │
│  │ 📋 발급 방법:                                   │  │
│  │  1. https://openweathermap.org 에 접속         │  │
│  │  2. 무료 회원가입                               │  │
│  │  3. "My API Keys" 메뉴에서 키 복사              │  │
│  │                                               │  │
│  │ [____________________________________]         │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  [저장하고 제품 시작하기]                             │
│                                                   │
│  ※ 필수 항목을 모두 입력해야 시작할 수 있습니다        │
│  ※ 입력한 정보는 암호화되어 저장됩니다                 │
│  ※ 수정 권한이 있는 사람만 이 값을 확인할 수 있습니다   │
└─────────────────────────────────────────────────┘
```

### 9.6 ENV 변경 시 프로세스

```
ENV 수정 (owner 또는 editor)
  → 현재 .env를 previous_encrypted_value에 백업
  → 새 .env 파일 생성
  → Docker 컨테이너 재시작
  → QA 재실행 (Claude Code CLI 에이전트 팀 + 브라우저)
    → 통과 → 정상 운영 계속
    → 실패 → ENV 관련 문제인지 분석
      → ENV 문제로 판단:
        "⚠️ 변경한 환경 변수로 인해 제품이 정상 작동하지 않습니다.
         문제: [OPENAI_API_KEY]가 유효하지 않습니다.
         이전 값으로 되돌리시겠습니까?"
        → [이전 값으로 롤백] → previous_encrypted_value 복원 → 재시작
        → [다시 입력하기] → ENV 입력 화면으로 이동
      → ENV 문제 아님 (코드 문제):
        일반적인 QA 실패 플로우로 처리
```

### 9.7 빌드 파이프라인 내 ENV 처리 순서

기존 빌드 파이프라인에 ENV 단계가 추가된다:

```
1. NestJS: mkdir + PRD 저장 + git init
2. Docker 컨테이너 생성
3. Hermes Pipeline: 빌드 + QA 사이클
4. .env.example 파싱 → ENV 필요 여부 판단
   → ENV 불필요: 바로 status = 'deployed'
   → ENV 필요: status = 'awaiting_env'
     → 사용자가 ENV 입력
     → .env 생성 + 컨테이너 재시작
     → QA 재실행
     → 통과 시 status = 'deployed'
```

### 9.8 Project 상태에 'awaiting_env' 추가

```sql
-- projects 테이블의 status ENUM 수정
status ENUM('scoring', 'building', 'qa', 'awaiting_env', 'deployed', 'failed', 'stopped')
```

---

## 10. 프로젝트 오케스트레이션 (NestJS)

### 9.1 빌드 프로세스

```typescript
// build.service.ts
async function buildProject(projectId: string) {
  const project = await this.projectRepo.findOne(projectId);

  // 1. 디렉토리 생성
  const projectPath = `/projects/${projectId}`;
  await fs.mkdir(projectPath, { recursive: true });

  // 2. PRD 저장
  const prdPath = `${projectPath}/prd.md`;
  await fs.writeFile(prdPath, project.prdContent);

  // 3. Git 초기화
  await exec(`cd ${projectPath} && git init`);
  if (project.gitRemote) {
    await exec(`cd ${projectPath} && git remote add origin ${project.gitRemote}`);
  }

  // 4. Docker 컨테이너 생성
  const port = await this.allocatePort(); // 3000~3999 중 미사용 포트
  const containerId = await this.docker.createContainer({
    image: 'node:20-slim',
    name: `project-${projectId}`,
    portBindings: { '3000/tcp': [{ HostPort: String(port) }] },
    binds: [`${projectPath}:/app`],
    workingDir: '/app',
  });

  // 5. 상태 업데이트
  await this.projectRepo.update(projectId, {
    status: 'building',
    port,
    containerId,
    projectPath,
    prdPath,
  });

  // 6. Builder Agent 호출 (비동기)
  this.runBuildPipeline(projectId, projectPath, prdPath, port);
}
```

### 9.2 포트 할당

```typescript
async function allocatePort(): Promise<number> {
  const usedPorts = await this.projectRepo
    .createQueryBuilder('p')
    .select('p.port')
    .where('p.port IS NOT NULL')
    .andWhere('p.status IN (:...statuses)', { statuses: ['building', 'qa', 'deployed'] })
    .getMany();

  const usedSet = new Set(usedPorts.map(p => p.port));

  for (let port = 3000; port <= 3999; port++) {
    if (!usedSet.has(port)) return port;
  }

  throw new Error('No available ports');
}
```

---

## 11. Frontend 화면 구성

### 10.1 메인 페이지 (프로젝트 리스트)

```
┌─────────────────────────────────────────┐
│  내 프로젝트                    [+ 새 프로젝트]  │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ 📦 Todo App          🟢 Running     │  │
│  │    만든 사람: 나 (owner)              │  │
│  │    🐳 Docker :3001                   │  │
│  │    http://localhost:3001             │  │
│  │    [버그 리포트] [서비스 개선] [중지]  │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ 📦 광고 성과 대시보드  🟢 Running    │  │
│  │    만든 사람: 김마케팅 | 나: editor   │  │
│  │    🐳 Docker :3002                   │  │
│  │    http://localhost:3002             │  │
│  │    [버그 리포트] [서비스 개선]         │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ 📦 Weather Dashboard  🔄 Building   │  │
│  │    만든 사람: 나 (owner)              │  │
│  │    🐳 Docker :3003                   │  │
│  │    빌드 중... (2/3 단계)              │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ 📦 영업 리포트 생성기  🟢 Running    │  │
│  │    만든 사람: 박영업 | 나: viewer     │  │
│  │    🐳 Docker :3004                   │  │
│  │    http://localhost:3004  [보기전용]  │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ 📦 Recipe Finder      🔴 Failed     │  │
│  │    만든 사람: 나 (owner)              │  │
│  │    🐳 Docker :3005                   │  │
│  │    QA 실패 - 3회 재시도 소진          │  │
│  │    [PRD 수정하기] [재빌드]            │  │
│  └─────────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

프로젝트 카드 표시 규칙:
- **만든 사람 + 내 권한**: 항상 표시. owner는 "나 (owner)", 타인 프로젝트는 "만든 사람: OOO | 나: editor/viewer"
- **Docker 포트**: 🐳 아이콘 + 포트 번호 표시 (3000~3999)
- **접속 URL**: Running 상태일 때만 링크 활성화
- **수정 버튼**: owner/editor만 보임. viewer는 [보기전용] 뱃지 표시
- **중지 버튼**: owner만 보임

### 10.2 스코어링 채팅 화면 (Discovery)

```
┌─────────────────────────────────────────┐
│  새 프로젝트: Todo App                     │
│                                           │
│  ┌─ 현재 단계 ────────────────────────┐   │
│  │ ● 문제발견  ○ 기능구조화  ○ 검증     │   │
│  └───────────────────────────────────┘   │
│                                           │
│  ┌─ 스코어: 650/1000 ───────────────┐    │
│  │ 🟠 문제는 정리됨 — 프로세스 미정립  │    │
│  │ ██████████████░░░░░░  (900점 필요) │    │
│  │                                     │   │
│  │ 문제정의 ████████████████░░ 160/200 │   │
│  │ 기능목록 █████████████░░░░░ 130/200 │   │
│  │ 사용흐름 ████████████░░░░░░ 120/200 │   │
│  │ 기술실현 ██████████████░░░░ 140/200 │   │
│  │ 사용경험 ██████████░░░░░░░░ 100/200 │   │
│  └───────────────────────────────────┘   │
│                                           │
│  🤖 어떤 상황에서 불편함을 느끼시나요?       │
│                                           │
│  👤 할일 관리가 불편해요. 포스트잇에         │
│     적어놓는데 자꾸 잃어버려요.              │
│                                           │
│  🤖 그렇군요. 지금은 어떻게 관리하고          │
│     계세요? 포스트잇 외에 다른 방법도         │
│     시도해보셨나요?                          │
│                                           │
│  [메시지 입력...]                  [전송]   │
│                                           │
│  ※ 스코어 900점 이상 시 [제작] 버튼 활성화   │
└─────────────────────────────────────────┘
```

### 10.3 빌드 진행 화면

```
┌─────────────────────────────────────────┐
│  Todo App - 빌드 중                       │
│                                           │
│  ✅ 1단계: 프로젝트 환경 준비               │
│  🔄 2단계: 코드 생성 중...                  │
│     └ AI가 지금 하는 일:                    │
│       "사용자 입력 폼 컴포넌트 생성 중"      │
│  ⬜ 3단계: QA 검증                         │
│  ⬜ 4단계: 배포                            │
│                                           │
│  ┌─ AI 작업 상태 ─────────────────────┐   │
│  │ 📁 생성된 파일: 4/12                 │   │
│  │ ⏱️ 경과 시간: 2분 31초               │   │
│  │ 🔧 현재 작업: src/components/Todo..  │   │
│  └───────────────────────────────────┘   │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ [실시간 빌드 로그 스트리밍]            │  │
│  │ > Creating package.json...           │  │
│  │ > Installing dependencies...          │  │
│  │ > Writing src/App.tsx...              │  │
│  └─────────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### 10.4 UX 투명성 원칙

아래 사항은 모든 화면에서 반드시 준수한다:

1. **현재 단계 표시**: Discovery(문제발견 → 기능구조화 → 검증) / Build / QA / Deploy 중 어디인지 항상 표시
2. **항목별 점수**: 총점뿐 아니라 5개 항목 각각의 점수를 시각적으로 표시하여, 사용자가 어느 부분을 보완해야 하는지 한눈에 파악
3. **AI 작업 실황**: 빌드/수정 중일 때 "AI가 지금 뭘 하고 있는지"를 자연어로 실시간 표시
4. **진척도 수치화**: 파일 생성 수, 경과 시간, 현재 작업 파일명 등 구체적 수치 제공
5. **접속 가능 상태 강조**: 배포 완료 시 URL을 가장 눈에 띄게 표시. 접속 불가 시에도 "현재 접속 불가 — QA 진행 중" 등 이유를 명시

---

## 12. 디렉토리 구조

```
/project-root/
├── frontend/                    # React + TypeScript
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx    # 프로젝트 리스트
│   │   │   ├── Chat.tsx         # 스코어링 채팅
│   │   │   └── BuildStatus.tsx  # 빌드 진행 상태
│   │   ├── components/
│   │   │   ├── ChatMessage.tsx
│   │   │   ├── ScoreBar.tsx
│   │   │   ├── ProjectCard.tsx
│   │   │   └── BuildLog.tsx
│   │   ├── hooks/
│   │   │   ├── useChat.ts       # 채팅 상태 관리
│   │   │   └── useWebSocket.ts  # 실시간 빌드 상태
│   │   └── api/
│   │       └── client.ts        # API 호출 래퍼
│   ├── package.json
│   └── tsconfig.json
│
├── backend/                     # NestJS + TypeScript
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
│   │   │       ├── conversation.entity.ts
│   │   │       └── build-log.entity.ts
│   │   ├── scoring/
│   │   │   ├── scoring.module.ts
│   │   │   └── scoring.service.ts     # Gemini 3.0 Flash API 호출
│   │   ├── build/
│   │   │   ├── build.module.ts
│   │   │   ├── build.service.ts       # 오케스트레이션 + Hermes Pipeline 호출
│   │   │   ├── docker.service.ts      # Docker 컨테이너 관리
│   │   │   └── port-allocator.ts      # 포트 할당
│   │   ├── websocket/
│   │   │   └── build.gateway.ts       # WebSocket 이벤트
│   │   └── app.module.ts
│   ├── package.json
│   └── tsconfig.json
│
├── bridge/                      # Python: Hermes Agent → Claude Code CLI
│   ├── hermes_pipeline.py       # 빌드 + QA + 수정 통합 파이프라인
│   └── requirements.txt         # hermes-agent
│
├── projects/                    # 빌드된 프로젝트들 (gitignore)
│   ├── {project-id-1}/
│   │   ├── prd.md
│   │   ├── data/
│   │   │   └── app.db           # 프로젝트 전용 SQLite
│   │   ├── src/
│   │   └── ...
│   └── {project-id-2}/
│       ├── prd.md
│       ├── data/
│       │   └── app.db
│       └── ...
│
├── docker/
│   ├── docker-compose.yml       # MySQL + Nginx
│   └── nginx.conf               # 리버스 프록시 설정
│
├── .env.example
├── .gitignore
└── README.md
```

---

## 13. Docker Compose & 프로젝트 격리

모든 사용자 프로젝트는 개별 Docker 컨테이너에서 격리 실행된다.
포트 범위는 3000~3999으로 제한하며, 최대 1000개 프로젝트를 동시 운영 가능하다.

```yaml
version: '3.8'

services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
      MYSQL_DATABASE: ai_builder
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "3000-3999:3000-3999"  # 프로젝트 포트 범위
    volumes:
      - ./docker/nginx.conf:/etc/nginx/nginx.conf
    depends_on:
      - backend

  backend:
    build:
      context: ./backend
    ports:
      - "4000:4000"
    environment:
      - DATABASE_URL=mysql://root:${DB_ROOT_PASSWORD}@mysql:3306/ai_builder
      - GEMINI_API_KEY=${GEMINI_API_KEY}
    depends_on:
      - mysql
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # Docker-in-Docker
      - ./projects:/projects
      - ./bridge:/bridge

volumes:
  mysql_data:
```

### 12.1 프로젝트별 Docker 컨테이너 규칙

- 각 프로젝트는 `project-{projectId}` 이름의 독립 컨테이너로 실행
- 베이스 이미지: `node:20-slim` (기본), 프로젝트 요구에 따라 Python 이미지도 지원
- 내부 포트 3000 → 호스트 포트 3000~3999 매핑
- 컨테이너 간 네트워크 격리 (프로젝트 A가 프로젝트 B에 접근 불가)
- 컨테이너 리소스 제한: CPU 0.5 core, Memory 512MB (MVP 기준)
- 프로젝트 삭제 시 컨테이너 + 볼륨 + 데이터 디렉토리 함께 정리

### 12.2 프로젝트별 SQLite 격리

각 프로젝트가 데이터 저장이 필요한 경우, 프로젝트 내부에 SQLite 파일을 사용한다. 외부 DB 서버(MySQL, PostgreSQL 등)에 의존하지 않는다.

```
/projects/{project-id}/
├── prd.md
├── src/
├── data/
│   └── app.db          ← 이 프로젝트 전용 SQLite
├── package.json
└── README.md
```

이점:
- **격리성**: 한 프로젝트 DB가 손상되어도 다른 프로젝트에 영향 0
- **정리 용이**: 프로젝트 삭제 시 디렉토리만 삭제하면 DB도 함께 삭제
- **인프라 단순화**: 프로젝트별 DB 서버 세팅 불필요. 파일 하나로 완결
- **백업 용이**: SQLite 파일 복사만으로 프로젝트 데이터 백업 가능
- **Docker 볼륨**: `/app/data/`를 호스트의 `/projects/{id}/data/`로 마운트하여 컨테이너 재시작 시에도 데이터 유지

```typescript
// docker.service.ts — 컨테이너 생성 시
const containerId = await this.docker.createContainer({
  image: 'node:20-slim',
  name: `project-${projectId}`,
  portBindings: { '3000/tcp': [{ HostPort: String(port) }] },
  binds: [
    `${projectPath}:/app`,           // 소스코드
    `${projectPath}/data:/app/data`, // SQLite 데이터 (persist)
  ],
  workingDir: '/app',
  hostConfig: {
    memory: 512 * 1024 * 1024,  // 512MB
    nanoCpus: 500000000,         // 0.5 CPU
  },
});
```

참고: 플랫폼 자체(NestJS 백엔드)의 사용자/프로젝트/세션 관리에는 MySQL을 사용한다. SQLite는 개별 프로젝트 앱의 데이터 저장용이다.

---

## 14. 플랫폼 환경 변수

```env
# .env.example

# Database
DB_ROOT_PASSWORD=your_mysql_password

# Gemini (Scoring/Discovery Agent)
GEMINI_API_KEY=AIza...

# Hermes Agent (Builder/QA 오케스트레이터)
# Hermes는 자체 config를 사용하지만, API 키는 환경변수로도 설정 가능
OPENROUTER_API_KEY=sk-or-...    # 또는 ANTHROPIC_API_KEY

# Claude Code CLI (Builder/QA 실행)
# 사전에 `claude login` 완료 필수.
# Claude Code는 호스트 머신의 ~/.claude/ 인증 정보를 사용함.

# JWT
JWT_SECRET=your_jwt_secret

# Ports
BACKEND_PORT=4000
PROJECT_PORT_RANGE_START=3000
PROJECT_PORT_RANGE_END=3999
```

---

## 15. 구현 우선순위

### Phase 1: 코어 (1주)
1. NestJS 프로젝트 생성 + MySQL 연결 + Entity 정의
2. Gemini 3.0 Flash API 연동 (Discovery Agent)
3. 채팅 API + conversation_history DB 저장/로드
4. React 채팅 UI + 1000점 스코어 바 + 구간별 상태 표시

### Phase 2: 빌드 파이프라인 (1주)
5. Hermes Agent 설치 + Python Bridge (hermes_pipeline.py — 빌드+QA+수정 통합)
6. NestJS → Python Bridge 호출 로직
7. Docker 컨테이너 생성/관리 서비스 (dockerode)
8. 포트 할당 로직 (3000~3999)
9. 빌드 오케스트레이션 (mkdir → PRD 저장 → git init → Hermes Pipeline 단일 호출 → 배포)

### Phase 3: 프론트엔드 완성 (1주)
10. 프로젝트 대시보드 (만든 사람, 권한, 상태, Docker 포트, URL)
11. 빌드 진행 화면 + WebSocket 연동 (Claude Code stdout 실시간 스트리밍)
12. 버그 리포트 / 서비스 개선 플로우 (PRD 먼저 업데이트 → 자기 참조적 수정)
13. 프로젝트 권한 관리 UI (owner/editor/viewer)

### Phase 4: 안정화 (3~4일)
14. Nginx 리버스 프록시 설정
15. 에러 핸들링 + 재시도 로직 보강
16. Docker Compose 통합 테스트

---

## 16. 사전 준비 및 Claude Code 실행 지시사항

### 15.1 사전 준비 (수동, 1회)

```bash
# 1. Claude Code CLI 설치 + 로그인
npm install -g @anthropic-ai/claude-code
claude login

# 2. Hermes Agent 설치
pip install git+https://github.com/NousResearch/hermes-agent.git

# 3. 정상 작동 확인
claude -p "Hello, are you working?" --output-format stream-json
python -c "from run_agent import AIAgent; print('Hermes OK')"
```

Claude Code CLI와 Hermes Agent 모두 호스트 머신에 직접 설치되어 있어야 한다.
NestJS 백엔드가 Python Bridge를 통해 Hermes를 호출하고,
Hermes가 내부적으로 Claude Code CLI를 터미널 도구로 실행한다.

### 15.2 이 PRD를 Claude Code에게 전달할 때

```
1. 이 PRD를 읽고 전체 구조를 파악하세요.
2. Phase 1 → Phase 4 순서로 구현하세요.
3. 각 Phase가 끝날 때마다 테스트를 실행하여 정상 작동을 확인하세요.
4. Hermes Agent를 pip install로 설치하세요:
   pip install git+https://github.com/NousResearch/hermes-agent.git
5. Claude Code CLI가 이미 설치·로그인된 상태임을 전제합니다.
6. Python Bridge는 backend에서 child_process.spawn으로 호출합니다.
7. Docker 컨테이너 관리에는 dockerode npm 패키지를 사용하세요.
8. 환경 변수는 .env.example을 기반으로 .env 파일을 만드세요.
9. 백엔드는 TypeScript strict 모드, Bridge는 Python 3.11+로 작성하세요.
```

---

## 17. 성공 기준

- 비개발자가 아이디어를 텍스트로 입력하면, 스코어링 대화를 거쳐 PRD가 확정된다.
- 확정된 PRD로 빌드 버튼을 누르면, 실제 접속 가능한 URL이 생성된다.
- QA를 통과하지 못하면 자동 수정 후 재시도하며, 최대 3회 실패 시 사용자에게 피드백한다.
- 배포된 서비스에 대해 버그 리포트/개선 요청을 동일 프로세스로 처리할 수 있다.
- 여러 사용자가 동시에 각자의 프로젝트를 독립적으로 관리할 수 있다.
