# ADR 0005: Mock-first env 전략 — env는 선행 조건이 아니라 점진적 향상

- **상태**: Accepted
- **일시**: 2026-04-19
- **관련**: PRD §7.6, §8, §9, §10, ADR 0001, 0004

## 배경

현재 설계는 env를 **배포의 선행 조건**으로 다룬다. `.env.example`에 user-required 변수가 있으면 유저가 다 채울 때까지 `awaiting_env`에서 멈추고, 실제 API 키가 들어와야만 `deployed`로 간다(§9.1).

이 설계에 **구조적 모순**이 있다.

```
빌드는 qa_fix까지 완결돼야 끝남
qa_fix는 기능 검증이 필요
기능은 env가 있어야 돌아감
env는 빌드가 끝나야 유저에게 물어볼 수 있음
  → 순환
```

지금의 해법은 "초기 QA는 HTTP 헬스체크까지만" 하는 **얕은 검증**으로 순환을 비껴간 것. 하지만 이는 실제 통합 로직을 검증하지 못한다. env가 들어온 뒤 `env_qa`에서 터지면 원인이 "값 틀림" / "통합 버그" / "외부 장애" / "기획 부실" 중 뭔지 명확히 구분하기 어려워 FailureClassifier(ADR 0002)가 떠안은 책임이 비대해졌다.

또 UX 관점에서도 "환경 설정 끝낼 때까지 앱을 못 본다"는 경험이 비개발자 오너에게 **부정적인 첫 인상**을 준다 — 만드는 중인 것이 실체로 잡히지 않으면 해결 과정에 대한 동기가 떨어진다(PRD §1 핵심 전제).

## 결정

**env는 점진적 향상(progressive enhancement)으로 취급한다.** 앱은 env 없이도 돌아가야 하며, env는 기능을 "실제화"하는 후행 단계다.

### 규칙

1. **env 의존 모듈은 반드시 mock/real 분기 구현.** Claude Code가 생성하는 모든 env 의존 코드(LLM 호출, 외부 API, 결제, 인증 등)는 다음 패턴을 따른다:
   ```js
   // services/llm.js
   const REAL = !!process.env.AX_AI_TOKEN;
   export async function chat(prompt) {
     if (REAL) return callRealLLM(prompt);
     return mockChat(prompt);  // 결정적 더미 응답
   }
   ```

2. **mock은 결정적·설명적이어야 한다.** 같은 입력에 같은 출력, 그리고 가능하면 "⚠ mock 응답입니다" 같은 마커를 응답에 포함해 유저가 mock 상태임을 즉시 인지.

3. **초기 빌드 QA는 mock 상태로 통과**. qa_fix도 mock 응답 기반으로 통합 코드 경로를 검증.

4. **빌드 완료 = `deployed`.** `awaiting_env`는 블로킹 선행 조건이 아니라 **선택적 사이드 상태**로 재정의(ADR 0006 참조).

5. **env 입력 → real 전환은 배포 후.** 실패 처리 기본값은 `modifying`(채팅 수정) — `planning` bounce는 스키마 자체가 PRD와 모순되는 극단 케이스만.

### 역할 분리

| 시점 | 검증 대상 | 수단 |
|---|---|---|
| 빌드 중 (qa·qa_fix) | 앱 구조 — 포트 바인드, 라우팅, mock 응답 경로, 에러 핸들링 | 관찰 QA(ADR 0001) + mock 모듈 |
| env 주입 후 (env_qa) | env 값 유효성 — auth 통과, 기본 응답 형태 | 실제 API 1~2회 ping |
| 배포 후 | 실제 비즈니스 로직, 엣지 케이스 | 유저 피드백 → modifying 세션 |

## 대안

- **A. env를 빌드 직전에 유저에게 미리 물어보기**: 아이디어 단계에서 어떤 키가 필요할지 결정해야 함. Planning 단계에 기술 세부가 새어들어감 — "비개발자 친화" 원칙 위반.
- **B. env 없이도 테스트 가능한 기능만 만들도록 범위 축소**: 제품 범위가 너무 좁아짐. LLM·결제·지도 등 대부분의 실제 유용 앱이 제외됨.
- **C. env 주입 전용 sandbox 계정을 플랫폼이 공급**: 비용·법적 위험·오남용 우려. 각 provider마다 관리 부담.
- **D. 현 상태 유지 + FailureClassifier 개선**: 증상 치료. 구조적 모순은 그대로.

## 결과

**장점**
- **UX**: 유저가 즉시 동작하는 앱을 얻음. "아직 반쪽"이라도 화면이 돌아가는 실감.
- **진단 경계 명확**: 구조 문제(빌드 QA) / env 값 문제(env_qa) / 로직 문제(modifying)가 분리됨. 각 단계 실패가 의미하는 바가 1:1.
- **실패 비용 감소**: env 입력 후 터지는 건 이미 돌고 있던 앱의 **수정**. 전체 재빌드 필요 없음.
- **테스트 가능성 부수 효과**: mock 모듈이 기본 존재 → 앱이 자동으로 테스트 친화적.
- **오프라인 개발 가능**: env 없이도 UI 확인·수정 가능해 개발 루프 빠름.

**단점 / 주의**
- **mock 품질이 UX 결정**: 너무 뻔한 더미면 실감이 없고, 너무 진짜 같으면 "왜 AI 응답이 똑같지?" 컴플레인. 결정적이면서도 설명적인(⚠ 마커 포함) 응답이 정답.
- **Claude Code 프롬프트 의존**: mock 패턴 예시 스니펫을 주입해도 LLM이 지키는지는 변동성 있음. 스캐폴드 체크(grep `process.env.AX_AI_TOKEN` + 분기문)로 강제하는 린터 단계 필요.
- **배포됐지만 실제 기능은 안 돌아감**을 유저가 인지해야 함. UI 배너 필수.
- **코드 크기 증가**: 각 모듈에 mock 버전 추가 — 작은 앱에서도 10~30% 코드 증가 예상.

## 연관 구현

**Phase 6 예정 (PRD §15)**

- `building-agent/phase_runner.py` — PHASE 프롬프트 템플릿에 mock 래퍼 예시 스니펫 + "env 의존 모듈은 반드시 mock/real 분기" 규칙 추가
- `building-agent/qa_supervisor.py` — 기존 관찰 QA 유지. env 없이 기동 전제.
- `orchestrator/src/agents/building.runner.ts` `handleExit` — user-required 존재와 무관하게 `deployed`로 직행. env sync는 배포 후 백그라운드로.
- 상태 머신 — `building → qa → deployed` 단일 해피 패스. `awaiting_env`/`env_qa`는 **배포 후 사이드 트랜지션**으로 재정의(ADR 0006).
- FailureClassifier — `env_qa` 실패 기본 라우팅을 `modifying`으로. `env_rejected`만 `awaiting_env` 복귀 유지.
- 프론트 — 대시보드에 mock 상태 배너, "환경 설정" CTA는 선택 진입점으로.
- `.env.example` 메타라인 — 기존 `# 주입:` 외에 `# mock_default:` 추가 검토(초기 mock이 어떤 값을 쓸지 힌트).

## 교차 참조

- **ADR 0006** — 이 전략이 성립하려면 env 입력/수정/재시작 UI가 **배포 후 언제든** 동작해야 함.
- **ADR 0002** — FailureClassifier의 `env_qa` 실패 기본 라우팅이 `planning`에서 `modifying`으로 전환.
- **PRD §1** — 비개발자 친화성 원칙에 정합. "즉각적인 실감" 강화.
