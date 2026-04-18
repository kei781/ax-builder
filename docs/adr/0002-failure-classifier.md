# ADR 0002: FailureClassifier — QA 실패를 책임 주체로 분기

- **상태**: Accepted
- **일시**: 2026-04-19
- **관련**: PRD §8.3, §9.1, §10.1

## 배경

기존 정책은 "QA 실패 = 즉시 Planning 반송"이었다. 하지만 실제 실패 원인은 다양하다:

- 유저가 API 키 오타를 냈다 → "기획부터 다시"는 비합리적.
- 외부 서비스가 일시적으로 503 → 잠깐 뒤 재시도만 해도 성공.
- 앱 코드에 `TypeError` → 이건 진짜 Claude Code가 잘못 짠 것. 기획 반송이 맞음.
- env 스키마 자체가 잘못 정의 → 유저가 3번 재입력해도 계속 실패.

한 덩어리의 "실패"를 네 가지로 분리해서 **고칠 수 있는 주체**에게 돌려야 한다.

## 결정

4-way 분류기를 도입한다.

| # | 원인 | 시그니처 | 핸들링 |
|---|---|---|---|
| 1 | `env_rejected` | 401, 403, Unauthorized, Invalid.\*key | `awaiting_env` 복귀, 최대 3회 재입력 |
| 2 | `transient` | ECONNREFUSED, ETIMEDOUT, 503, 502 | 현 상태 유지 + 지수 백오프 재시도(1·5·15분) + 수동 재시도 버튼 |
| 3 | `code_bug` | SyntaxError, TypeError, ReferenceError, 포트 미바인드, 파싱 실패 | Planning bounce-back |
| 4 | `schema_bug` | 같은 변수에서 케이스 1이 3회 연속 | Planning bounce-back (변수 이력 첨부) |

**판정 순서**
1. **regex 룰 테이블** — 에러 로그에 대한 1차 매칭. 확정되면 즉시 분기.
2. **LLM judge** (Gemini `qa_judge` 슬롯) — 1차에서 미매칭 시 2차. 프롬프트: "env/transient/code 중 무엇인가".
3. **안전 폴백** — 2차도 모호하면 `code_bug`로 처리. (유저를 재입력 지옥에 두지 않음 — 이 쪽이 더 보수적 안전판.)

## 대안

- **A. 전부 LLM judge**: 프롬프트 비용·레이턴시 부담. regex로 거를 수 있는 80%는 무료로 거르는 게 낫다.
- **B. 고정 룰만**: 로그가 규칙 밖일 때 분류 불가. 다양한 프레임워크·언어 대응 불가.
- **C. 분기 없이 전부 유저에게 표시**: 비개발자가 `TypeError` 로그 보고 판단할 수 없음. UX 참사.

## 결과

**장점**
- 비개발자 UX가 극적으로 개선 — "키 틀려서 다시 입력하세요"와 "앱 코드 버그라 기획부터 다시"가 명확히 구분됨.
- Planning 반송 비용 절감 — 불필요한 Gemini·Claude Code 호출 감소.
- 에러 분포 통계로 플랫폼 병목 파악 가능 (env_rejected가 많으면 가이드 개선, code_bug가 많으면 프롬프트 강화 등).

**단점 / 주의**
- 분류가 틀릴 수 있음 — 401이 실제로는 서버 버그일 수도 있다. 폴백 정책 중요.
- regex 룰 테이블 유지 비용. 새 런타임·프레임워크 추가 시 갱신 필요.
- LLM judge 일관성 — 같은 로그에 다른 판정을 내릴 수 있음. 프롬프트 고정 + 몇 개 시드 예시 포함.

## 연관 구현

- `building-agent/failure_classifier.py` 신규 — regex 룰 테이블 + judge 호출 + 결과 타입.
- `orchestrator/src/builds/` — 분류 결과를 `build_phases.failure_kind` 컬럼에 저장.
- `orchestrator` 상태 머신 — `qa` / `env_qa`에서 분류 결과 기반 전이.
- 대시보드 UI — 실패 시 분류 결과별 메시지/행동 유도.
