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

## Claude Code 제어 인터페이스 — 개요

Claude Code에 명령을 보내는 방법은 **세 가지 축**이 있고 각자 노출 범위가 다르다. wikidocs 류 문서들이 종종 이를 섞어 설명해 혼란을 유발하므로 명시한다.

| 인터페이스 | Claude Code 역할 | 클라이언트가 얻는 것 | LLM 위임 | 비고 |
|---|---|---|---|---|
| **MCP (client 방향)** | MCP **client** | 외부 MCP 서버의 tool을 가져와 자기 세션에서 씀 | 해당 없음 (LLM은 자기 것) | 사용자가 터미널에서 `claude` 쓸 때. 대부분의 wikidocs MCP 가이드가 이 방향. |
| **MCP (`claude mcp serve`)** | MCP **server** | Claude Code의 tool(Read/Write/Edit/Bash 등)을 JSON-RPC로 **빌려줌** | **❌ 불가** | 공구 창구 — LLM으로 판단하는 건 클라이언트 몫. |
| **`--input-format stream-json`** | 자율 에이전트 | Claude에게 user message를 넣으면 **자기 LLM + 자기 tool loop로 작업 완성** | **✅ 가능** (OAuth 구독 크레딧 사용) | Claude Desktop·Cursor가 Claude Code 원격 제어할 때 쓰는 프로토콜. |

우리 시나리오("외부 오케스트레이터가 정액제 크레딧으로 Claude에 일 위임")에 맞는 건 **세 번째**만이다. 두 번째(`mcp serve`)로 하면 LLM을 외부가 돌려야 해서 정액제 혜택 소실.

## 대안

### A. 유지 (subprocess + `--print --output-format text`)
- **장점**: 코드 변경 없음
- **단점**: 위 고통 반복. 환경 오염·파싱 오류(warning 섞임)·고아 프로세스·세션 단절

### B. Anthropic SDK 직접 호출
- **장점**: 인증 단순화 (`ANTHROPIC_API_KEY` 하나), 환경 오염 없음, subprocess 사고 없음
- **단점**: **정액제 포기 → 사용량 과금** (Claude Pro/Team 구독 혜택 상실). tool use loop를 우리가 직접 구현 (Read/Write/Edit/Bash dispatch 코드 수백 줄). permission·cwd·CLAUDE.md 자동 로드를 전부 재구현.

### C. `claude mcp serve` + MCP 클라이언트 (**검토 후 탈락**)
- **초안 아이디어**: `claude mcp serve`로 노출된 `Agent` tool에 `subagent_type="general-purpose"`로 phase 프롬프트 위임 → LLM 위임까지 한 번에.
- **실측 결과**: `mcp serve` 모드의 `Agent` tool은 subagent 정의를 **어떤 방법으로도 로드하지 못함**.
  - `subagent_type="general-purpose"` → `Agent type 'general-purpose' not found. Available agents:` (리스트 비어있음)
  - `~/.claude/agents/general-purpose.md` 파일 생성 후 재시도 → 여전히 비어있음
  - `--agents '{...JSON...}'` flag를 `claude ... mcp serve` 앞에 부착 → 여전히 비어있음
- **결론**: `mcp serve`는 **원시 tool만 노출**하는 "공구 창구"이지 LLM 엔진을 외부에 빌려주는 통로가 아님. 위 표의 두 번째 축이 증명.
- 이 접근으로 가면 결국 Hermes가 LLM을 자체 공급해야 하므로 B(SDK)와 사실상 동일한 단점으로 수렴.

### D. 본 안 — `claude --print --input-format stream-json --output-format stream-json`
- **장점**:
  - **정액제 유지**: LLM 호출이 Claude Code 내부에서 일어나 OAuth 구독 크레딧 사용 (init 이벤트 `apiKeySource: "none"` 확인)
  - **구조화된 이벤트 스트림**: `thinking`/`tool_use`/`tool_result`/`result` 이벤트가 stdout에 JSON 한 줄씩. 기존 `--output-format text`가 stderr warning과 섞여 파싱 오염됐던 문제 해결 (회고 §6).
  - **에이전틱 위임**: Hermes가 Claude Code에 prompt 한 덩어리만 전달, tool loop(Read/Write/Edit/Bash/Glob/Grep)는 Claude가 자율 수행
  - **관찰성 상승**: tool_use 이벤트마다 어떤 file_path에 뭘 하는지 로그 누적 가능 → classifier 입력·진행도 추적 모두 향상
  - **공식 프로토콜**: Claude Desktop·Cursor가 Claude Code를 원격 제어할 때 쓰는 인터페이스. `ps`로 Claude Desktop 자식 프로세스 확인 시 동일 인자 관찰됨 → 향후 지속성 높음.
- **단점**:
  - 이벤트 파싱 로직 (~100줄 Python) 필요. 단 단일 파일에 집약되고 JSON line-by-line이라 단순.
  - **환경 오염 문제는 그대로**: `claude` binary 경로는 여전히 spawn. `CLAUDE_CODE_OAUTH_TOKEN` stale 이슈는 ecosystem.config.cjs 오버라이드(회고 §8, 커밋 `24c31f1`)로 이미 봉쇄됨.
  - `Bash` tool은 `--permission-mode acceptEdits`에서 자동 승인 안 됨 → `npm install` 같은 명령을 phase prompt가 자발적으로 건너뛰는 경우 있음. QA에서 어차피 재실행하므로 실질적 영향 無.
  - Claude Code 2.1.x의 stream-json 스키마(`type=result`, `content[].type`)에 의존. 버전 업 시 회귀 테스트 필요.

## 구현 전략

### 1. stream-json stdio 파이프
`subprocess.Popen`으로 Claude Code 실행, stdin에 user message JSON 한 줄 쓰고 stdout을 line-by-line 파싱.

```python
proc = subprocess.Popen(
    [settings.CLAUDE_BIN, "--print",
     "--input-format", "stream-json",
     "--output-format", "stream-json",
     "--permission-mode", "acceptEdits",
     "--verbose"],
    cwd=str(project_path), env=claude_env,
    stdin=PIPE, stdout=PIPE, stderr=PIPE, text=True, bufsize=1,
)
proc.stdin.write(json.dumps({
    "type": "user",
    "message": {"role": "user", "content": phase_prompt},
}) + "\n")
proc.stdin.close()

for line in proc.stdout:
    evt = json.loads(line)
    if evt["type"] == "assistant":
        # thinking / tool_use 로그 수집
    elif evt["type"] == "result":
        return ok = not evt.get("is_error"), text = evt.get("result")
```

### 2. phase_runner.py
```python
def run_phase(phase, ..., mode="build") -> PhaseResult:
    prompt = _compose_prompt(...)
    ok, final_text, tool_log, n_tools, errs = _run_claude_stream(
        prompt, project_path, timeout=CLAUDE_PHASE_TIMEOUT_S,
    )
    return PhaseResult(ok=ok, stdout=final_text + tool_log, stderr=errs, ...)
```

### 3. 세션 lifecycle
MVP: phase마다 새 subprocess (현재와 격리 수준 동일). 장점 — phase 간 컨텍스트 오염 없음. 단점 — 매 phase 새로 세션 초기화(cache_creation_input_tokens 누적). 후속 최적화로 "한 빌드에 한 세션"은 stream-json이 여러 user message를 연속 받도록 확장 가능하나 MVP는 단일 턴.

### 4. permission
`--permission-mode acceptEdits` — Read/Write/Edit/NotebookEdit 자동 승인. Bash는 별도로 승인 필요 → prompt가 `npm install` 같은 명령은 자발적으로 skip할 수 있음. QA 단계에서 어차피 재실행하므로 phase 완성도에 영향 無.

### 5. 관찰성
stdout이 이벤트 스트림이라 다음이 공짜로 나옴:
- `num_tool_uses` — phase 중 Claude가 호출한 tool 개수
- `tool_use_log` — 각 호출의 name·file_path 한 줄씩
- `rate_limit_event` — 사용량 경고
- `total_cost_usd` — result 이벤트에 포함 (관측·청구용)

이 정보를 classifier 입력과 build_phases.output_log에 함께 싣는다.

## 결과

**장점**
- stdout 파싱 오염 (warning 섞임) 구조적 제거
- 정액제 유지 — 과금 모델 불변
- Hermes의 에이전틱 비전 실현 — Claude Code가 "시키는" 대상이 아니라 Hermes가 **호출하는 도구**
- tool_use 이벤트 관찰로 classifier 입력 풍부화 + phase 진행도 추적 기반 마련
- 공식 Claude Desktop·Cursor가 쓰는 프로토콜이라 향후 지속성 높음

**단점/주의**
- Claude Code 2.1.x stream-json 이벤트 스키마(`type=result`, `type=assistant[.content.type]` 등)에 의존. CLI 버전 업 시 회귀 테스트 필수.
- 실패 모드 변경: subprocess exit code → `result.is_error` 기반. classifier는 기존 output_log 기반이라 호환 유지.
- 환경 오염 문제는 여전히 `claude` binary 실행 맥락에 존재. ecosystem.config.cjs 오버라이드(회고 §8) 유지 필수.
- 단일 턴 모델 — 여러 phase 간 Claude 컨텍스트 재활용은 불가(MVP 스코프 외).

## 연관 구현

- `building-agent/phase_runner.py` 재작성 — `_run_claude_stream()` 신규 + `run_phase()` 교체
- `building-agent/orchestrator.py` — mode/prompt 전파는 그대로
- `building-agent/mcp_client.py` — **생성 후 폐기**. 초안의 `mcp serve` 접근으로 만들었으나 C 탈락으로 제거. 이 ADR이 역사적으로 남음.
- ARCHITECTURE §4.2 "Claude Code 층 (실행)" 섹션 — subprocess → MCP 기반 기술로 갱신
- PRD §XX (해당 구현 사항 반영)

## 교차 참조

- 회고 §6 — subprocess stdout 파싱 오염
- 회고 §7 — QA 포트 충돌 (관련 낮음, 참고 수준)
- 회고 §8 — `CLAUDE_CODE_OAUTH_TOKEN` env 오염 (이번 전환의 직접 동기)
- ADR 0001 — 관찰 QA (그대로 유지, QA 경로는 무관)
- ADR 0008 — 업데이트 라인 (그대로 유지)
