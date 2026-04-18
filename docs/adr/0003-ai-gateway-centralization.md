# ADR 0003: AI Gateway 단일 경유 (agent-model-mcp)

- **상태**: Accepted
- **일시**: 2026-04-19
- **관련**: PRD §9.0, §18
- **리포**: `github.com/kei781/agent-model-mcp`

## 배경

생성된 앱이 LLM을 쓰려면 지금은 유저가 **provider API 키(Anthropic/OpenAI/Gemini)를 직접 발급받아 입력**해야 한다. 비개발자에게 이것은 사실상 불가능에 가깝고, 설령 넣는다 해도:

- 키 유출 시 과금 폭탄
- 플랫폼이 앱 사용량·비용을 관찰·통제할 수 없음
- 모델 업그레이드 시 앱별 재배포 필요
- 내부 에이전트(Planning, Hermes, Claude Code CLI)도 각자 직접 provider를 호출 — 플랫폼 전체 AI 비용을 한 곳에서 보기 어려움

## 결정

**모든 LLM 호출**(플랫폼 내부 에이전트 + 생성된 앱 + 외부 MCP 클라이언트)을 **단일 AI Gateway**(`agent-model-mcp`)를 경유하도록 강제한다.

- **프로토콜**: OpenAI-호환 HTTP (+ SSE 스트리밍) + MCP (Streamable HTTP).
- **인증**: 프로젝트당 1개 `AX_AI_TOKEN` 발급. 빌드 완료 시 orchestrator가 컨테이너 env로 자동 주입. 유저 UI에 숨김.
- **모델 라우팅**: 논리 이름(`default`, `cheap`, `reasoning`)으로 호출 → 게이트웨이가 실제 모델로 매핑. 업그레이드 투명.
- **예산**: 프로젝트별 일일/월 cap, 초과 시 429 또는 저렴 모델 자동 폴백(opt-in).
- **감사**: 모든 호출 로깅. 프로젝트·토큰 단위 사용량·비용 대시보드.
- **빌드 규칙**: Claude Code가 생성한 `.env.example`·코드에서 `ANTHROPIC_API_KEY`·`OPENAI_API_KEY` 등 provider 키 직접 참조가 발견되면 스캐폴드 QA가 bounce-back (ADR 0004 분류와 연계).
- **passthrough**: OpenAI 포맷으로 담기 어려운 기능(Anthropic tool use, thinking, caching)은 원본 포맷 endpoint 병행 (`/v1/anthropic/messages` 등).

## 대안

- **A. 유저가 직접 키 입력** (현 상태): UX 파산 + 통제 불능.
- **B. 플랫폼 공용 키 1개를 모든 앱에 주입**: 통제 불가능. 한 앱의 남용이 다른 앱까지 차단.
- **C. LiteLLM 같은 기존 오픈소스 사용**: 검토 가치 있음. 하지만 MCP 통합·프로젝트 단위 토큰 발급·ax-builder 내부 통합을 커스텀하려면 어차피 많은 글루 코드가 필요. `agent-model-mcp`를 자체 유지하는 게 플랫폼 전략과 정합.

## 결과

**장점**
- **env UX 혁신**: LLM만 쓰는 앱은 유저 입력 env 0개.
- **비용 통제**: 프로젝트별 cap으로 과금 사고 봉쇄.
- **모델 교체 투명**: 중앙 설정 1회 변경으로 전체 생성 앱 업그레이드.
- **키 유출 내성**: 앱 누출 시 게이트웨이 토큰만 폐기.
- **플랫폼 가치 제고**: 사용량 대시보드, 모델 추천, 비용 절감 자동화 등 고부가가치 레이어 추가 가능.
- **내부 통일**: Planning, Hermes, Claude Code CLI 전부 같은 게이트웨이 — 플랫폼 전체 AI 비용을 한 곳에서 본다.

**단점 / 주의**
- **단일 장애점(SPOF)**: 게이트웨이 죽으면 플랫폼 정지. LLM은 어차피 외부 의존이라 체감 증가는 제한적이지만, health check·자동 재시도·graceful degradation 필수.
- **기능 매트릭스 유지**: tool use, vision, thinking, prompt caching 등 각 provider의 고급 기능을 중계하려면 지속적인 업데이트 필요. passthrough 모드로 완화.
- **레이턴시 증가**: 같은 LAN이면 수 ms. 다른 리전이면 50~100ms. N100 로컬 배포 구조에선 사실상 무시 수준.
- **스트리밍 백프레셔**: 느린 클라이언트가 쌓이면 게이트웨이 연쇄 지연. per-request 버퍼 제한 필수.

## 연관 구현

- `agent-model-mcp` 리포 — OpenAI-호환 + MCP + 토큰 발급 + 사용량 로깅 (별도 프로젝트).
- `orchestrator` — 빌드 완료 시 Gateway admin API로 토큰 발급 + 컨테이너 env 주입.
- `phase_runner.py` 프롬프트 — LLM 호출 예시 스니펫 포함 (openai SDK with base_url).
- Planning Agent — `openai_compat` 백엔드를 Gateway 가리키도록 기본값 변경.
- Claude Code CLI — `ANTHROPIC_BASE_URL` 설정으로 Gateway 경유 (Gateway가 Anthropic passthrough 제공).
