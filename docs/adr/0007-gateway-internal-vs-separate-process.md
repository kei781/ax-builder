# ADR 0007: AI Gateway 구현 위치 — orchestrator 내장 우선

- **상태**: Accepted — Phase 6 MVP
- **일시**: 2026-04-19
- **관련**: ADR 0003, PRD §18, ARCHITECTURE §20

## 배경

ADR 0003은 **"AI Gateway를 단일 경유로 둔다"** 라는 **철학**을 합의했다. 구현 위치(어디서 돌릴 것인가)는 미정이었고, PRD §18 초안은 별도 프로세스 `agent-model-mcp`(기존 slot-routing MCP stdio 서버)를 가정해서 작성됐다.

Phase 6 구현 시점에 두 경로를 비교했다:

- **A. 별도 프로세스**: `agent-model-mcp`에 OpenAI-호환 HTTP 레이어 + 토큰 admin API + 사용량 로깅을 추가. 완결된 독립 서비스.
- **B. orchestrator 내장**: NestJS orchestrator 안에 `ai-gateway/` 모듈을 붙여 `/api/ai/v1/*` 엔드포인트를 직접 노출.

## 결정

**MVP는 orchestrator 내장(B)**. 외부 프로세스 `agent-model-mcp`는 Phase 6.1에서 backend(slot-routing layer)로 통합 고려.

## 근거

1. **상태 소유 중복 회피**: 토큰(`projects.ai_token_hash`), 프로젝트 수명주기, 컨테이너 restart 트리거는 전부 orchestrator가 이미 관리. 별도 프로세스로 빼면 두 시스템이 같은 데이터(프로젝트 존재 여부, 토큰 유효성)를 중복으로 알아야 함 — 동기화 비용·스큐 위험.
2. **네트워크 단순화**: 생성 앱 컨테이너(Docker Desktop mac)는 `host.docker.internal:4000`으로 host orchestrator에 자동 도달. 추가 프로세스는 추가 포트·DNS 관리.
3. **MVP 복잡도 최소화**: Phase 6 목표는 "mock → real 전환이 실제 되는가" 검증. 그것만 풀려고 프로세스 하나를 더 관리하는 것은 과함.
4. **slot-routing은 직교 관심사**: `agent-model-mcp`가 가진 진짜 가치는 slot→provider 매핑(OpenRouter ↔ Ollama 전환). 이건 Gateway 뒤쪽(upstream 선택) 관심사이지 HTTP 레이어 관심사가 아님. Phase 6.1에서 Gateway의 upstream 선택자를 `agent-model-mcp` MCP tool 호출로 대체할 수 있다 — 계층 책임이 더 명확해짐.
5. **재배치 비용 낮음**: Gateway를 나중에 분리하고 싶어지면 `ai-gateway/` 모듈을 별도 서비스로 떼어내는 건 몇 시간 작업 (HTTP 인터페이스는 변하지 않음).

## 대안

- **A. 별도 프로세스로 처음부터 분리**: 책임 경계는 선명하지만 ①②③ 비용이 즉시 발생. Phase 6 시간 예산에 비해 과잉.
- **C. Nginx/Envoy 같은 기성 프록시 + lightweight auth plugin**: 기성 도구 조합으로 가능하지만 토큰 생명주기가 orchestrator에 있어 커스텀 plugin 필요. 결국 코드를 어딘가에 써야 함 → 그럴 바엔 이미 익숙한 NestJS에 쓰는 게 낫다.

## 결과

**장점**
- Phase 6 MVP 코드 증가 최소 (약 400 LOC, 모듈 3개)
- 토큰 발급/해시/검증 경로가 DB와 같은 트랜잭션 컨텍스트 공유
- 컨테이너에서 gateway까지 수 ms (host loopback)

**단점 / 주의**
- orchestrator 프로세스에 LLM 트래픽이 섞임 — 장애 격리 면에서 이상적이지 않음. Phase 6.1에서 사용량·예산 제어가 들어가면 orchestrator CPU/메모리 부담이 늘어날 수 있다. 그 시점에 분리 재검토.
- `agent-model-mcp` 리포의 slot 개념과 아직 통합 안 됨. 지금은 논리 모델 이름(`default|cheap|reasoning|fast`)이 orchestrator의 하드코딩 매핑에 묶여있음. 슬롯 모델 VRAM 관리 같은 기능은 agent-model-mcp를 backend로 붙일 때 복원.

## 연관 구현

- `orchestrator/src/ai-gateway/*` (ADR 0003 참조)
- PRD §18 MVP·6.1 섹션 분리 기술
- ARCHITECTURE §20.2 (MVP 인터페이스) vs §20.3 (6.1 확장)
