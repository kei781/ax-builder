# ADR 0008: 업데이트(수정) 상태 라인 분리

- **상태**: Accepted
- **일시**: 2026-04-20
- **관련**: PRD §10, ARCHITECTURE §7, ADR 0002·0005·0006

## 배경

플랫폼은 두 종류의 "빌드 사이클"을 가진다:

1. **첫 빌드** — 아이디어에서 출발, PRD 새로 작성, 앱 전체를 새로 생성, 처음 배포.
2. **업데이트** — 이미 돌아가는 앱이 있고, 유저가 기능 추가·버그 수정을 요청, 기존 코드·PRD를 **diff** 방식으로 갱신, 새 버전 배포.

초기 설계는 두 사이클을 같은 상태 라인(`planning → plan_ready → building → qa → deployed`)에 `modifying`이라는 단일 진입 state만 추가해서 묶어둔 상태였다. 실구현에선 `modifying`이 이름만 있고 실제 전이·로직이 `planning`과 동일하게 흘러가서 유저 관점에서 **업데이트인데 첫 빌드처럼 동작**하는 문제가 쌓였다.

**실제로 문제가 된 불변식**
- 업데이트 실패 시 "기존 배포된 버전은 살아있어야 한다" — 암묵적. 코드로 보장 안 됨.
- Planning Agent가 업데이트 세션에서 기존 PRD를 **전체 재작성**하지 않는다 — 프롬프트가 분기 안 됨.
- Building Agent가 기존 코드를 건드리지 않는 범위를 식별한다 — 지시 없음. 전 phase 새로 생성해버림.
- QA가 기존 기능의 regression을 본다 — 현재 QA는 "앱이 뜸"만 확인.

**발단이 된 증상** (2026-04-20 "랜덤 간식 당번" 건): 배포된 프로젝트에 유저가 기능 추가 채팅 → `propose_handoff` 성공 반환 — 하지만 `state='planning'`에서만 UPDATE하는 제약 때문에 실제 전이 안 됨. 유저는 "AI가 도구를 호출하지 않은 것 같아요" 배너만 계속 봄. 임시 패치(propose_handoff의 UPDATE 조건을 `planning OR modifying`으로 넓힘)는 증상만 가린 것.

## 결정

**업데이트 전용 상태 라인을 첫 빌드 라인과 분리한다.**

### D1. 새 상태 4개 추가

| state | 의미 | 대응되는 첫 빌드 state |
|---|---|---|
| `planning_update` | 유저가 수정 아이디어를 Planning Agent와 대화. 기존 PRD를 diff로 갱신. | `planning` |
| `update_ready` | 수정 사양 확정, "업데이트 시작" 버튼 대기. | `plan_ready` |
| `updating` | Building Agent가 변경 범위 적용 중. 기존 코드 보존. | `building` |
| `update_qa` | regression + 새 기능 검증. | `qa` |

`modifying` state는 `planning_update`로 리네임(사실상 폐기·치환). 기존 DB의 `modifying` row는 마이그레이션 단계에서 `planning_update`로 UPDATE.

### D2. 전이 그래프

```
[첫 빌드 라인]
draft → planning → plan_ready → building → qa → env_qa → deployed
                                                             │
                                                             │ (유저 수정 요청 or 배포 후 채팅 시작)
                                                             ▼
[업데이트 라인]
deployed → planning_update → update_ready → updating → update_qa → deployed (version+1)
    ▲                                            ▼           ▼
    │        rollback (기존 container·version 유지)           │
    └─────────────────────────────────────────────────────────┘

실패 분류(classifier 기반):
    updating: code_bug → planning_update bounce
              infra_error / transient → deployed 유지 + 토스트
              schema_bug → planning_update bounce (변수 이력)
    update_qa: regression_fail → planning_update bounce (회귀 발생 항목 첨부)
               새기능 fail → planning_update bounce (해당 기능 명세 보강 요청)
```

### D3. 공유 vs 분리 원칙

state는 분리하되 코어 로직은 함수 공유.

| 관점 | 분리 (state 기반 분기) | 공유 |
|---|---|---|
| Planning Agent system_prompt | ✅ | 기본 틀은 동일, update 섹션 추가 |
| Building Agent | ✅ mode 파라미터 | phase 실행·Claude CLI 호출 자체는 동일 |
| QA | ✅ regression case 추가 | 관찰 기반 QA 인프라 공유 |
| Docker 배포 | ✅ 롤백 시맨틱 | createContainer·env 주입 공유 |
| FailureClassifier | 공유 | 분류 결과가 state에 따라 라우팅만 다름 |
| 프론트 UI | ✅ 배지·카피·버튼 | 컴포넌트 구조 공유 |

### D4-bis. 업데이트 사이클 취소 (유저 주도 롤백, 2026-04-22 추가)

D4의 롤백은 **빌드 실패** 시 시스템이 수행하는 자동 롤백. 이번 추가는 **유저가 대화 중 "이 방향 아니다"** 판단했을 때의 사용자 주도 롤백이다.

배경: 배포된 앱에 업데이트 요청을 시작했지만 도중에 "내가 요구사항을 잘못 설명했다" / "기획 방향이 틀렸다"는 걸 깨닫는 경우. 대화를 그대로 두면 잘못된 방향이 이어지고, PRD에 이미 write_prd로 수정이 들어갔다면 롤백해야 원래 배포 상태로 돌아감.

구현:
1. **자동 백업**: `chat.service.archiveCurrentSessionForUpdate`(즉 `deployed → planning_update` 첫 진입 시점)가 `projects/<id>/.ax-build/pre-update-backup/`에 PRD.md·DESIGN.md 스냅샷 저장. 이미 백업 존재 시 덮어쓰지 않음 (사이클 중 여러 번 write_prd 호출돼도 **최초 진입 시점의 원본** 보존).
2. **취소 엔드포인트**: `POST /projects/:id/update/cancel` (ChatController)
    - state 요구: `planning_update` 또는 `update_ready`
    - 실행:
      1. 현재 session `archived`로 전환
      2. `.ax-build/pre-update-backup/`의 PRD·DESIGN을 원본 위치로 복사 → 백업 디렉토리 제거
      3. `projects.current_session_id` null
      4. `state → deployed` (VALID_TRANSITIONS 기존 경로 사용)
      5. WS `progress(phase='update_cycle_cancelled')` emit
3. **UI 트리거**: Chat header 상단 "↩ 업데이트 취소" 버튼 (planning_update / update_ready + owner/editor). 확인 모달에 "이 대화 + PRD 변경사항 모두 이전 상태로 복원" 명시 후 호출. 성공 시 대시보드로 이동.
4. **다중 협업자 동기화**: `update_cycle_cancelled` WS 이벤트를 다른 연결된 클라이언트가 수신하면 1.5초 후 자동으로 대시보드로 navigate.

**왜 첫 빌드 라인엔 이게 필요 없는가**: 첫 빌드(draft/planning/plan_ready)에서 "방향이 틀렸다"면 유저가 그냥 프로젝트를 **삭제**하고 새로 시작하면 됨 — 잃을 게 배포된 앱이 없으므로. 업데이트 라인만 "운영 중인 앱을 건드리지 않고 이번 사이클만 취소"가 의미 있음.

**D4-bis 세분 복원 레이어 (2026-04-24 추가 — 회고 §8)**: 위 "사이클 시작 전 스냅샷"보다 더 촘촘한 복원점이 필요한 사건(write_prd의 UPDATE 모드 catastrophic overwrite)이 발생했다. 대응으로 planning-agent `write_prd` 도구가 **매 덮어쓰기 직전** `PRD.md.bak.{iso8601Z}`를 남긴다. UI는 이 목록을 `GET /prd/backups`로 노출하고 `POST /prd/restore`로 복원. 두 레이어는 역할이 다르다 — `.ax-build/pre-update-backup/`은 **사이클 취소용**(단일 스냅샷), `PRD.md.bak.*`은 **write 단위 복원용**(여러 스냅샷). 두 레이어 모두 유지하되 취소 엔드포인트는 전자, 복원 엔드포인트는 후자만 건드린다. UPDATE 모드 유사도 가드(PRD 대비 `< 0.3` 또는 H1 변경 + `< 0.7`)가 도구 레벨에서 overwrite 자체를 reject하므로 실전에선 복원 기능이 과거 사고 피해 구제에 주로 쓰인다.

### D4. 롤백 시맨틱 (핵심 불변식)

**불변식**: `updating` / `update_qa` 실패 시 유저의 앱은 끊기지 않는다. 이전 버전 컨테이너가 계속 돌고 있어야 한다.

구현 전략 — **"이전 컨테이너를 섣불리 제거하지 않는다"**:

1. `update_ready → updating` 전이 시 `projects.previous_container_id` / `previous_version`에 현재 값 백업.
2. Building Agent가 phase를 실행하는 동안 이전 컨테이너는 **그대로 돌고 있다** (코드 적용은 프로젝트 디렉토리 파일 수정만).
3. Building Agent 성공 후 env-deploy가 **새 포트**에 **새 컨테이너**를 띄우고 헬스체크:
    - **헬스체크 성공** → 이전 컨테이너 제거, `current_version += 1`, `previous_*` clear, `deployed` 전이.
    - **헬스체크 실패** → 새 컨테이너만 제거. 이전 컨테이너 그대로 유지. DB의 `container_id` / `current_version`을 `previous_*`로 되돌림. 분류에 따라 `planning_update` 반송 또는 `deployed` 유지.
4. phase 실행 실패 (`updating` 중 exit 2) → 이전 컨테이너 건드리지 않았으므로 DB만 `previous_*`로 되돌리면 끝. 상태는 `planning_update` (code_bug / schema_bug / unknown) 또는 `deployed` (infra_error / transient).
5. 성공 시 `project_versions`에 새 버전 row 추가 (container_id, primary_endpoints 포함).

이 전략은 초안의 "git checkout으로 직전 커밋 체크아웃 후 createContainer" 같은 복구 경로를 필요 없게 만든다 — 이전 컨테이너가 살아있으므로 파일 시스템 상태와 무관.

### D5. 업데이트 에이전트 — 세션·페르소나 완전 격리 (2026-04-21 보강)

**초안 판단의 수정**: 초안은 "planning_update 세션에 시스템 프롬프트 섹션을 추가"하는 정도였으나, 실측 결과 부족. 유저가 배포된 앱에 "테스트 버튼 없어"라고 기능 추가 요청을 했는데 AI가 "개발 완료 후에 가능합니다"라고 **첫 빌드 언어로 답변**하는 현상 관찰 (2026-04-21 스크린샷). 원인 두 겹:
1. 같은 session을 재사용해 이전 planning 대화가 전부 LLM 컨텍스트에 실림 → "개발 전 단계" 착각
2. 시스템 프롬프트의 update suffix가 약해 "이미 배포된 앱" 제1원칙이 뚫림

**변경 — 3중 격리**:

1. **세션 격리** (`chat.service.ts`):
    - `deployed → planning_update` 진입 시 기존 session을 `archived`로 전환하고 `current_session_id`를 null로 비운다
    - `ensureActiveSession`이 새 session 생성 → LLM 대화 history는 깨끗한 상태에서 시작
    - 이전 대화는 DB에는 남지만 이번 사이클에 로드되지 않음 (PRD/DESIGN만이 진실원)

2. **독립 시스템 프롬프트** (`planning-agent/app/agent/system_prompt.py`):
    - 기존 `BASE_PLANNING_SYSTEM_PROMPT + UPDATE_SUFFIX` 조합 폐기
    - `UPDATE_SYSTEM_PROMPT` 독립 정의. `build_system_prompt(is_update_mode=True)`가 이것만 반환
    - 제1원칙: "이미 배포되어 운영 중인 앱에 새 기능 추가·수정"을 반복 강조
    - **"개발 완료 후 가능합니다" 같은 첫 빌드 언어를 명시적 금지**

3. **권한·책임 4부**:
    1. **실현 가능성 평가 선행** — 현재 스택에서 가능한지, 기존 기능과 충돌 없는지 평가 후 "반영 가능" 판단 시에만 문서 업데이트
    2. **문서 반영은 필수** — 대화로만 합의하고 끝내면 안 됨. 기존 PRD 컨벤션(섹션 번호, `[user-required]`/`[ai-fillable]` 태그, FR1/FR2 번호 체계) 유지
    3. **개발 가능성 지속 평가** — 매 write_prd 후 "이 문서만으로 개발팀이 구현 가능한가" 자체 점검, 모호하면 유저에게 추가 질문
    4. **기존 기능 보존 불변식** — DB 스키마 깨는 변경 금지, 기존 엔드포인트 계약 유지, 새 의존성만 추가

4. **UI 안내** (`frontend/src/pages/Chat.tsx`):
    - `planning_update`/`update_ready` + messages.length ≤ 2일 때 인디고 배너 노출: "↻ 업데이트 사이클을 새로 시작합니다. 이전 기획 대화는 PRD·DESIGN에 이미 반영돼 있습니다."
    - 빈 채팅 화면 placeholder를 "어떤 기능을 추가하거나 수정하고 싶으세요?"로 분기

이 3중 격리로 AI가 이미 배포된 앱의 맥락을 확실히 인지하며, 이전 대화로 오염되지 않음. `propose_handoff`는 이전과 동일하게 작동하되 "이 변경을 개발에 넘김" 의미로 재정의.

**경계 조건 (재발 방지를 위한 기록)**:

세션 격리 로직(`archiveCurrentSessionForUpdate`)은 **`deployed → planning_update` 전이 순간**에만 발동한다. 이 entry point를 지나지 않고 이미 `planning_update` / `update_ready` 상태로 DB에 들어가 있는 프로젝트(예: 이 코드 배포 이전에 `modifying` 상태에서 마이그레이션된 row, 또는 `planning_update` 상태에서 orchestrator가 재시작된 경우)는 자동 격리가 안 된다.

→ **일회성 backfill**로 해결:
```sql
BEGIN;
UPDATE sessions SET state='archived' WHERE id IN (
  SELECT current_session_id FROM projects
  WHERE state IN ('planning_update','update_ready') AND current_session_id IS NOT NULL
);
UPDATE projects SET current_session_id=NULL
  WHERE state IN ('planning_update','update_ready');
COMMIT;
```

이 SQL은 2026-04-21 실행됨 (`5f1e10a8 랜덤 간식 당번`, `783ba47d SNS 메시지 자동 답변`).

**후속 작업 (필요 시)**: `sessions` 엔티티에 `cycle` 필드 (`'initial' | 'update'`) 추가 → 생성 시 project state 라인에 따라 설정 → `ensureActiveSession`이 existing session의 `cycle`과 현재 project 라인 불일치 시 자동 archive. 구조적 완벽 방어지만 DB 스키마 변경과 마이그레이션 필요 — 현재 backfill로 충분하면 skip.

### D6. Building Agent — update 모드

```python
# building-agent/orchestrator.py
mode = 'build' if state == 'building' else 'update'
if mode == 'update':
    # 1. 기존 PRD.md와 신규 PRD.md(업데이트 버전)의 diff 읽기
    # 2. Hermes에게 "변경 범위만 PHASES 생성, 무관한 phase skip" 지시
    # 3. Claude Code 프롬프트에 "기존 파일 구조 보존, 명시적 변경만 적용" 추가
```

### D7. QA 확장 (regression)

`update_qa`는 기존 관찰 QA(포트 바인드 + HTTP 200) + 다음 추가:
- 이전 버전에서 동작했던 **primary endpoint 리스트**를 project_versions에 저장
- update 후 각각 curl → 200·의미있는 응답 받는지 확인
- 실패 시 regression으로 분류 → handoff의 `gap_list`에 "깨진 엔드포인트: X" 포함

## 대안

### A. 모두 공유 (현상 유지)
`modifying` 이름만 쓰고 로직은 동일. 이 ADR이 해결하려는 모든 문제가 그대로.

### B. 단일 state + 플래그
`project.update_mode: boolean` 같은 암묵 플래그. UI 카피만 분기.
- **장점**: 코드 변경 최소
- **단점**: state 이름만 보고 맥락 파악 불가 (로그·대시보드 debugging 힘듦). 플래그 설정 누락 시 조용히 잘못된 동작. 롤백 시맨틱이 state에 안 박힘.

### C. Middle ground — `update_ready`만 추가
`planning_update`는 별도, 하지만 building 이후는 공유.
- **장점**: 변경 범위 작음
- **단점**: `building` 안에서 다시 분기 필요 (context 플래그 결국 필요). 실패 라우팅이 애매 — building 실패가 update인지 첫 빌드인지 로그로만 구분.

### D. 본 안 — 4개 모두 분리
- **장점**: 각 단계 맥락 완전 분리. state 머신만 보면 흐름 파악. 롤백·regression 등 불변식을 state로 표현.
- **단점**: state 수 증가(8 → 12). VALID_TRANSITIONS 테이블 커짐. 코드 복잡도 소폭 상승.

**본 안 선택 근거**: 복잡도 증가는 일회성. state 명명이 명확해지면 이후 모든 개발·디버깅·문서화가 훨씬 쉬워짐. 특히 **롤백 불변식을 state로 표현**하는 이득이 큼 — code_bug 분류기에서 "updating 실패면 previous 복구, building 실패면 planning 반송"이 state만 보고 판단 가능.

## 결과

**장점**
- 유저: "업데이트 중" 배지·카피로 맥락 이해. 실패해도 기존 앱 계속 동작.
- 운영자: state machine 한눈에 맥락 파악. 로그·메트릭 분리해 "업데이트 실패율 vs 첫 빌드 실패율" 별도 추적.
- 개발자: 각 단계별 책임 명확. "updating phase 실패 시 롤백"이 명시적 코드.
- AI 에이전트: Planning·Building이 context(state)로부터 맥락 추론 가능.

**단점 / 주의**
- state 테이블·VALID_TRANSITIONS 커짐 — 정기적 정리 필요.
- 프론트 배지·카피 중복 (9개 state × UI 요소). config로 관리.
- 기존 코드에서 `state === 'planning'` 같은 체크가 여러 곳 — 마이그레이션 누락 시 버그 면 있음. **grep 리스트로 전수 확인 필수**.
- DB 마이그레이션 — 기존 `modifying` → `planning_update` 치환 + 새 state enum.

## 연관 구현 (Phase 6.1 단위로 진행)

### 백엔드
- `projects.entity.ts` ProjectState union: 4개 state 추가, `modifying` 제거
- `state-machine.service.ts` VALID_TRANSITIONS 재작성
- `projects.service.ts` — `previous_container_id` / `previous_version` 컬럼 추가
- `chat.service.ts sendUserMessage` — `deployed`에서 첫 메시지 시 `planning_update`로 전이 (지금 임시로 넣은 `modifying` 전이 교체)
- `propose_handoff.py` — `planning_update → update_ready`로 전이. 기존 `planning → plan_ready`와 병렬.
- `agents/building.runner.ts` — mode 파라미터(`build | update`) 추가. start()에서 state로 판단.
- `envs/env-deploy.service.ts` — update 실패 시 previous로 롤백. maintenance recreate도 롤백 경로 추가.
- `envs/failure-classifier.service.ts` — regression_fail 새 kind 추가 (선택, 또는 code_bug로 흡수)

### Planning Agent
- `planning-agent/app/agent/system_prompt.py` — update mode 분기 섹션
- `propose_handoff` tool 확장

### Building Agent
- `building-agent/orchestrator.py` — mode 인자
- Hermes 프롬프트 update 모드 분기
- `phase_runner.py` prompt 템플릿 — update context (기존 파일 보존 규칙)

### QA 확장
- `qa_supervisor.py` — update_qa 경로, primary endpoint curl 리스트
- `project_versions.primary_endpoints` JSON 컬럼

### 프론트
- `ProjectCard.tsx` stateConfig 4개 추가
- `Chat.tsx` 배너 카피 분기
- `BuildStatus.tsx` "업데이트 진행 중" 라벨

### 테스트
- E2E 스모크에 "배포 후 수정 사이클" 추가 (ADR 2026-04-20 retrospective §3.2)

## 교차 참조

- **ADR 0002** — FailureClassifier 라우팅 규칙에 update line 반영 (code_bug → planning_update, infra_error → deployed 유지 등)
- **ADR 0005** — mock-first 원칙은 update 라인에도 그대로. 새 env 추가 시 기본 mock.
- **ADR 0006** — env 유지보수 UI는 deployed 상태에서 항상 가용 (update 중에도 env 입력 가능)
- **회고 2026-04-20** — "선언한 계약이 경계에서 강제되지 않음" 패턴의 교과서 사례. 이 ADR이 해결 방향.
