# Architecture Decision Records

플랫폼의 방향성 결정을 기록. 날짜·맥락·대안을 남겨서 "왜 이렇게 됐지"가 나중에 복원 가능하게.

형식: [Michael Nygard ADR](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

| # | 제목 | 상태 |
|---|---|---|
| [0001](./0001-port-observation-based-qa.md) | 관찰 기반 QA (포트 주입 폐지) | Accepted |
| [0002](./0002-failure-classifier.md) | FailureClassifier — QA 실패를 책임 주체로 분기 | Accepted |
| [0003](./0003-ai-gateway-centralization.md) | AI Gateway 단일 경유 (agent-model-mcp) | Accepted |
| [0004](./0004-env-tier-classification.md) | env 3-tier 분류 | Accepted |
| [0005](./0005-mock-first-env-strategy.md) | Mock-first env 전략 — 점진적 향상 | Accepted |
| [0006](./0006-env-maintenance-ui.md) | Env 유지보수 UI + 재시작 + 밸리데이션 | Accepted |

## 새 ADR 추가 규칙

- 파일명: `NNNN-kebab-case-title.md` (번호는 4자리 zero-padded)
- Status: `Proposed` / `Accepted` / `Deprecated` / `Superseded by NNNN`
- 의사결정의 **대안**과 **거부 이유**를 반드시 기록. "이게 최선"이 아니라 "왜 다른 걸 안 골랐는지".
