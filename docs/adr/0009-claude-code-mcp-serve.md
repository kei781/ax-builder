# ADR 0009: Claude Code를 Hermes의 도구로 — stream-json 프로토콜 전환

> **수정 노트 (같은 날)**: 초안은 `claude mcp serve`를 쓰려 했으나 실측 결과 `mcp serve` 모드의 `Agent` tool이 `subagent_type` 정의를 **어떤 방법으로도** 로드하지 못해(`Available agents: [비어있음]`, `--agents` flag·`~/.claude/agents/` 파일 둘 다 무시) LLM 위임이 불가. 같은 목적을 달성하는 유일한 공식 인터페이스는 `claude --print --input-format stream-json --output-format stream-json` — Claude Desktop이 Claude Code를 원격 제어할 때 쓰는 프로토콜. 방향성(Hermes가 Claude Code를 자기 도구로 호출)은 같고, 수단만 바뀐다.

- **상태**: Accepted
- **일시**: 2026-04-20
- **관련**: ARCHITECTURE §4 (Building Agent), 회고 §6·§7·§8

## 배경

현재 `building-agent/phase_runner.py`는 각 phase마다 `subprocess.run([claude, "--print", "--permission-mode", "acceptEdits", prompt])`로 Claude Code CLI를 일회용 spawn한다. 편의는 많지만 누적된 고통:

- **stdout/stderr 잡음**: `"Warning: no stdin data received in 3s..."` 같은 경고가 에러 로그에 섞여 classifier 입력 오염 (회고 §6).
- **환경변수 오염**: pm2 God daemon이 Claude Desktop 쉘에서 뜨면 `CLAUDE_CODE_OAUTH_TOKEN` stale 값이 자식에 상속 → 재인증해도 401 지속 (회고 §8).
- **프로세스 격리 실패**: 한 phase의 Claude CLI가 hang하면 parent인 orchestrator가 재시작될 때 고아로 남음 (회고 §5).
- **세션 단절**: phase마다 새 프로세스라 context 로드가 매번 처음부터. 토큰·시간 낭비.
- **"에이전트의 도구"가 아님**: Hermes(오케스트레이터)의 원래 설계 의도는 Claude Code를 **자기 손에 쥔 도구로 자율 호출**하는 것. 현재는 "한 번에 모든 걸 시킨다"는 단방향 batch에 가까움.

## 결정

**Claude Code CLI를 stream-json 프로토콜로 호출하고, Hermes가 stdin에 user message를 넣으면 Claude가 자율적으로 tool loop를 돌려 phase를 완성한다.**

- 호출: `claude --print --input-format stream-json --output-format stream-json --permission-mode acceptEdits --verbose`
- stdin: `{"type":"user","message":{"role":"user","content":"<phase prompt>"}}` (라인 단위 JSON)
- stdout: 이벤트 스트림
  - `{"type":"system","subtype":"init",...}` — 세션 정보(tools, agents, model, apiKeySource)
  - `{"type":"assistant","message":{...,"content":[{"type":"thinking",...}]}}`
  - `{"type":"assistant","message":{...,"content":[{"type":"tool_use","name":"Write",...}]}}`
  - `{"type":"user","message":{"content":[{"type":"tool_result",...}]}}`
  - `{"type":"result","subtype":"success"|"error","is_error":bool,"result":"<final text>",...}` — 종료 신호
- tool 실행(Read/Write/Edit/Bash)은 Claude Code 내부에서 수행 — Hermes는 실행 위임, 이벤트만 관찰
- LLM 호출은 Claude Code가 OAuth 구독으로 처리 (`apiKeySource: "none"` 확인됨 → 정액제 유지)

## 대안

### A. 유지 (subprocess + `--print`)
- **장점**: 코드 변경 없음
- **단점**: 위 고통 반복. 환경 오염·파싱 오류·고아·세션 단절

### B. Anthropic SDK 직접 호출
- **장점**: 인증 단순화 (`ANTHROPIC_API_KEY` 하나), 환경 오염 없음, subprocess 사고 없음
- **단점**: **정액제 포기 → 사용량 과금** (Claude Pro/Team 구독 혜택 상실). tool use loop를 우리가 직접 구현 (Read/Write/Edit/Bash dispatch 코드 수백 줄). permission·cwd·CLAUDE.md 자동 로드를 전부 재구현.

### C. 본 안 — `claude mcp serve` + Hermes가 MCP 클라이언트
- **장점**:
  - **정액제 유지**: LLM 호출이 Claude Code 내부에서 일어나므로 OAuth 구독 크레딧 사용
  - **표준 JSON-RPC**: stdout 파싱·warning 오염 제거
  - **세션 연속성**: 한 빌드에 한 MCP 세션으로 여러 phase 처리 → context 재활용
  - **에이전틱**: Hermes가 Claude Code의 `Agent` / `Read` / `Edit` 등을 도구처럼 조합 호출
  - **환경 오염 격리**: 여전히 `claude` binary를 spawn하지만 `mcp serve` stdio 프로토콜에 묶여 있어 동작 경계가 명확
  - **tool loop는 Claude Code가 전담**: SDK 전환처럼 우리가 직접 구현할 필요 없음
- **단점**:
  - MCP stdio 클라이언트(JSON-RPC)를 Python에 구현 (~150~250줄)
  - phase_runner 재작성 (subprocess.run → session.call_tool)
  - permission 정책: `mcp serve`는 클라이언트에 승인 위임. 로컬 stdio라 기본은 auto-approve지만 명시적 정책 문서화 필요
  - **환경 오염 문제는 그대로**: `claude` binary 경로는 동일. `CLAUDE_CODE_OAUTH_TOKEN` stale 이슈는 ecosystem.config.cjs 오버라이드(회고 §8 커밋 `24c31f1`)로 이미 봉쇄됨

## 구현 전략

### 1. MCP 클라이언트 (`building-agent/mcp_client.py`)
JSON-RPC 2.0 over stdio. blocking request/response. Agent tool이 오래 걸릴 수 있어 timeout은 phase 단위로 관대하게 (기본 `CLAUDE_PHASE_TIMEOUT_S`).

```python
class ClaudeCodeMcpClient:
    def __enter__(self):  # subprocess.Popen + initialize handshake
    def call_tool(self, name: str, arguments: dict, timeout: float) -> dict
    def __exit__(self):   # graceful close
```

### 2. phase_runner.py
```python
def run_phase(phase, ..., mode="build") -> PhaseResult:
    prompt = _compose_prompt(...)
    with ClaudeCodeMcpClient(cwd=project_path) as cc:
        result = cc.call_tool("Agent", {
            "description": f"Phase: {phase.name}",
            "prompt": prompt,
            "subagent_type": "general-purpose",
        }, timeout=settings.CLAUDE_PHASE_TIMEOUT_S)
    # result.content의 마지막 text가 subagent 요약
    return PhaseResult(ok=..., stdout=summary, ...)
```

### 3. 세션 lifecycle
MVP: phase마다 새 MCP 세션 (현재와 격리 수준 동일). 후속 최적화로 "한 빌드에 한 세션" 전환 가능 — Agent tool 호출 간 context 재사용.

### 4. permission
stdio 전송이라 클라이언트가 Hermes 자체. Hermes는 신뢰됨(자체 호스트). 기본 auto-approve. 추후 악성 Agent 실행 방어가 필요하면 Hermes 쪽에서 tool call 검증 단계 추가.

## 결과

**장점**
- 환경 오염·stdout 파싱·session 단절 등 3종 세트 구조적 제거
- 정액제 유지 — 과금 모델 불변
- Hermes의 에이전틱 비전 실현 — Claude Code가 "시키는" 대상이 아니라 Hermes가 **호출하는 도구**
- 미래: phase 사이 컨텍스트 공유, 병렬 tool 호출, `Agent` 외의 다른 tool 조합 가능

**단점/주의**
- 새 의존성: MCP 프로토콜·JSON-RPC 구현. 버전 호환성(MCP 2024-11-05) 주시 필요
- Agent tool의 응답 포맷(content array의 마지막 text가 요약)에 의존. Claude Code 버전 업그레이드 시 검증 필요
- 실패 모드 변경: subprocess exit code 기반 → JSON-RPC error 기반. classifier 재조정 필요
- 환경 오염 문제는 여전히 `claude` binary 실행 맥락에 존재. ecosystem.config.cjs 오버라이드 유지 필수

## 연관 구현

- `building-agent/mcp_client.py` 신규 — JSON-RPC stdio 클라이언트
- `building-agent/phase_runner.py` 재작성 — Agent tool 호출 기반
- `building-agent/orchestrator.py` — mode/prompt 전파는 그대로
- `building-agent/config.py` — `CLAUDE_MCP_SERVE_CMD` 설정 추가 (기본값 `["claude", "mcp", "serve"]`)
- ARCHITECTURE §4.2 "Claude Code 층 (실행)" 섹션 — subprocess → MCP 기반 기술로 갱신
- PRD §XX (해당 구현 사항 반영)

## 교차 참조

- 회고 §6 — subprocess stdout 파싱 오염
- 회고 §7 — QA 포트 충돌 (관련 낮음, 참고 수준)
- 회고 §8 — `CLAUDE_CODE_OAUTH_TOKEN` env 오염 (이번 전환의 직접 동기)
- ADR 0001 — 관찰 QA (그대로 유지, QA 경로는 무관)
- ADR 0008 — 업데이트 라인 (그대로 유지)
