# ADR 0004: env 3-tier 분류 (system-injected / user-required / user-optional)

- **상태**: Accepted
- **일시**: 2026-04-19
- **관련**: PRD §9.1.1, §9.2, ADR 0003

## 배경

"생성된 앱의 env"는 하나의 평평한 목록이 아니다. 세 가지가 섞여 있다:

1. 플랫폼이 주입하는 인프라 변수 (`AX_AI_TOKEN`, `AX_AI_BASE_URL`) — 유저는 알 필요 없음.
2. 유저가 직접 발급해야만 하는 외부 서비스 키 (Stripe, 카카오맵) — 유저 UI에 나와야 함.
3. 옵션 키 (있으면 기능 확장) — 유저에게 선택지로 노출.

지금은 이 구분이 없어서, 만약 Claude Code가 `.env.example`에 `ANTHROPIC_API_KEY`를 넣으면 유저에게 그대로 노출된다. 이것은 ADR 0003의 AI Gateway 철학과 정면 충돌.

## 결정

`.env.example`의 각 변수 블록에 `# 주입: <kind>` 메타라인을 추가하고, 3분류로 동작을 분기한다.

| 분류 | 누가 주입 | 유저 UI 노출 | 예 |
|---|---|---|---|
| `system-injected` | orchestrator가 빌드 완료 시 자동 | 숨김 | `AX_AI_TOKEN`, `AX_AI_BASE_URL`, `AX_STORAGE_PATH` |
| `user-required` | 유저 | 필수 입력 | Stripe, 카카오맵 등 외부 비-AI 서비스 |
| `user-optional` | 유저 | 선택 입력 | 추가 기능 토글용 외부 키 |

메타라인 누락 시 기본값은 `user-required`. 이유: 안전 측면 — 유저가 의도치 않게 빈 변수로 배포되지 않도록.

**regex 가드레일** — provider API 키 식별자(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` 등)가 `user-required`/`user-optional`로 올라오면 스캐폴드 QA가 즉시 bounce-back. AI Gateway를 거쳐야 하므로 이 변수들은 유저 입력 대상이 될 수 없다.

## 대안

- **A. 메타라인 없이 naming 규칙**: `AX_*` prefix = system, 기타 = user. 단순하지만 Claude Code가 규칙을 지킨다는 보장 없음. 가드레일이 필요.
- **B. 별도 파일 `.env.system`·`.env.user`**: 파일이 늘어남. 한 파일에 메타라인이 더 깔끔.
- **C. orchestrator가 빌드 후 자동 분류 (LLM)**: 비결정적. 명시적 메타가 낫다.

## 결과

**장점**
- 유저에게 노출할 변수와 숨길 변수가 결정적으로 분리됨.
- Claude Code가 `.env.example`을 잘못 작성해도 가드레일이 잡아냄.
- `system-injected` 목록은 플랫폼 운영자가 추후 자유롭게 확장 가능 (예: `AX_STORAGE_PATH`, `AX_TELEMETRY_URL`).

**단점 / 주의**
- Claude Code 프롬프트에 `# 주입: system-injected` 메타라인 작성 규칙을 **예시 스니펫**까지 박아 넣어야 순종률 확보. 규칙 1줄만으로는 약함.
- 메타라인 파싱이 엄격하면 Claude Code가 다른 표기(예: `# kind: system`)를 쓸 때 누락 발생. 파서는 관대하게 (`kind`, `주입`, `source` 등 동의어 받기).

## 연관 구현

**현재 상태 (PR #4)**

- `orchestrator/src/envs/env-parser.ts`
  - 메타라인 키 한/영 동의어 수용 (`설명/desc/description`, `발급/issuance`, `주입/tier/source` 등)
  - `parseEnvExample` — `ParsedEnvVar[]` 반환
  - `findProviderKeyViolations` — provider 키 user-tier 노출 금지 (ADR 0003 가드)
  - 메타라인 누락 시 `user-required` 기본값 (안전 측면)
- `orchestrator/src/envs/entities/project-env-var.entity.ts` — `(project_id, key)` UNIQUE, `tier` / `value_ciphertext` / `required` 등.
- `orchestrator/src/envs/envs.service.ts`
  - `syncFromExample` — 파싱 → 가드 → upsert (기존 값 보존) → stale 제거 → 요약 반환 (system_injected / user_required_pending / ...)
  - `resolveSystemInjected` — 키 이름 → 실제 값 매핑 (§20.2)
  - `submit` — 유저 입력 쓰기. `system-injected`는 방어적으로 무시. required 빈값 거부.
  - `writeDotenv` — 복호화해서 프로젝트 디렉토리에 `.env` 기록 (escape 포함)
- `phase_runner.py` — PHASE 프롬프트 템플릿에 `.env.example` 규격 + provider 키 금지 규칙 주입.
- `frontend/src/pages/EnvInput.tsx` — user-required(필수 섹션) / user-optional(접힘) / system-injected(숨김) 분리 렌더링. 보기·숨기기 토글, 기존값 마스킹 preview.

**아직 안 한 것**

- `resolveSystemInjected`가 인식하는 키 목록 확장 (AX_TELEMETRY_URL 등).
- 메타라인 파서 테스트 스위트 — 현재 인라인 smoke 테스트 수준.
