# TODO — 문서 vs 구현 불일치 항목

> 2026-04-20 문서-코드 대조 후 정리. Phase 6.1-A(ADR 0008) 구현 직후 발견된 gap.
> 우선순위 순. `[ ]`는 미완료, `[x]`는 완료.

---

## 크리티컬 (유저 경험에 직접 영향)

### [x] 1. `qa` / `update_qa` state 전이 구현 — 2026-04-20 완료

- **문제**: PRD §10.1에 `building → qa → env_qa → deployed` 및 `updating → update_qa → deployed` 명시. 하지만 실제 코드는 `building → env_qa` / `updating → env_qa`로 바로 건너뜀.
- **영향**: UI 배지 "검증 중"(qa) / "회귀 검증 중"(update_qa)이 **절대 표시되지 않음**. DESIGN.md §5.1이 명시한 업데이트 라인 차별화 UX의 핵심(`update_qa` 시안색 "회귀 검증 중" 배지)이 죽은 상태.
- **관련 파일**:
  - `orchestrator/src/agents/building.runner.ts:408` — `handleExit()` 성공 분기
  - `orchestrator/src/state-machine/state-machine.service.ts` — VALID_TRANSITIONS에는 경로 있음
  - `frontend/src/components/ProjectCard.tsx` — stateConfig에 qa/update_qa 있지만 도달 불가
- **선택지**:
  - (A) 코드 수정 — 성공 시 building→qa→env_qa / updating→update_qa→env_qa로 단계 전이. qa state 진입 시 WS 이벤트 방출해 UI가 배지 전환.
  - (B) 문서 수정 — PRD/DESIGN에서 qa·update_qa를 "state가 아닌 phase"로 명시. stateConfig에서도 제거.
- **권장**: (A). 업데이트 라인의 색 체계 의도(ADR 0008 §D3 분리 원칙)를 살리려면 state 전이가 UI의 단일 진실원.

---

## 중간 (문서·코드 모순, 유저 영향은 작음)

### [x] 2. PRD §10.1 `updating → planning` 경로 오타 — 2026-04-20 완료 (ARCHITECTURE.md §7도 동시 정리)

- **문제**: PRD.md:992 `updating → planning (schema_bug)` 표기. VALID_TRANSITIONS엔 없고 구현도 `planning_update`로 라우팅. ADR 0008 §D2와도 불일치.
- **관련 파일**:
  - `PRD.md:992`
  - `orchestrator/src/agents/building.runner.ts` (handleExit update 라인 bounce)
- **조치**: PRD.md:992를 `updating → planning_update (code_bug/schema_bug)`로 수정. 그리고 라인 977 `env_qa → planning (schema_bug)`에 "(fresh 모드만)" 주석 추가 — update/maintenance 모드는 `planning_update`로 감을 명시.

### [x] 3. ADR 0008 §D4 "git checkout 복구" 문구와 구현 괴리 — 2026-04-20 완료

- **문제**: ADR.md "컨테이너 이미 제거됐으면 프로젝트 디렉토리 git checkout으로 직전 커밋 체크아웃 후 createContainer"라고 적혀있음. 실제 구현은 이전 컨테이너를 **아예 제거하지 않는 방식**으로 단순화 (`freshDeploy`가 update 모드면 헬스체크 성공 전까지 previous 컨테이너 유지). git checkout 경로 필요 없음.
- **관련 파일**:
  - `docs/adr/0008-update-state-line-separation.md` §D4
  - `orchestrator/src/envs/env-deploy.service.ts:136` (freshDeploy isUpdate 분기)
- **조치**: ADR §D4 문구를 "새 컨테이너 헬스체크 성공 전까지 previous 컨테이너를 보존. 실패 시 새 컨테이너만 제거, previous는 무중단 유지. DB의 container_id/current_version을 previous_*로 되돌림."으로 단순화.

---

## 사소 (미학·경계 조건)

### [x] 4. DESIGN §5.1.1 deployed 카드 버튼 표기 vs 실제 구현 — 2026-04-20 완료

- **문제**: DESIGN에 `[🎮 열기] [⚙ 환경 설정] [🔄 재시작] [수정 요청]` 버튼 목록 명시. ProjectCard.tsx는 "🌐 접속 →" 링크 + 환경 설정/재시작/수정 요청 버튼으로 구성. 기능 동일, 표기만 차이.
- **관련 파일**:
  - `DESIGN.md` §5.1.1
  - `frontend/src/components/ProjectCard.tsx:84`
- **조치**: DESIGN의 버튼 스펙을 실제 레이아웃에 맞게 업데이트하거나, ProjectCard에 "🎮 열기" 버튼 형태로 통일.

### [ ] 5. DESIGN §5.1 "민트" vs Tailwind `bg-teal-500`

- **문제**: DESIGN에 update_ready 배지 색을 "민트"로 표현. 코드는 `bg-teal-500`. Tailwind에선 민트에 더 가까운 건 `bg-emerald-*` 계열이지만, teal도 청록/민트 범주로 수용 가능.
- **관련 파일**:
  - `DESIGN.md` §5.1
  - `frontend/src/components/ProjectCard.tsx` stateConfig
- **조치**: 실기기에서 색감 확인 후 `bg-emerald-*`로 변경하거나 DESIGN을 "teal(청록/민트 계열)"로 표기. **우선순위 낮음.**

### [ ] 6. ADR 0008 §D7 "이전 버전 동작 엔드포인트" vs 정적 스캔

- **문제**: ADR §D7은 "이전 버전에서 동작했던 primary endpoint 리스트를 project_versions에 저장"로 표현. 실제 qa_supervisor는 Express 라우트를 **정적 스캔**해 선언된 라우트를 모두 probe → 응답한 것만 저장. "동작했던"과 "선언된 라우트 중 응답한 것"은 겹치지만 정확히 같진 않음.
- **관련 파일**:
  - `docs/adr/0008-update-state-line-separation.md` §D7
  - `building-agent/qa_supervisor.py:108` `_scan_routes()`
- **조치**: ADR §D7에 "구현: Express 스타일 라우트 정적 스캔 + HEAD probe. 응답하는 엔드포인트만 저장."로 구현 방식 명시.

---

## 정보성 (후속 작업, 지금은 보류)

### [ ] 7. PRD §15 항목 43 — E2E 스모크 "배포 후 수정 사이클"

- **내용**: Phase 6.1-A 항목 43 "E2E 스모크 — 배포 후 수정 사이클" 미구현.
- **관련 파일**:
  - `orchestrator/smoke-*.mjs` (기존 스모크들)
  - `docs/ops/troubleshooting-retrospective-2026-04-20.md` §3.2
- **조치**: `smoke-update-cycle.mjs` 신규. 플로우: 첫 빌드 완료 → deployed → 채팅으로 수정 요청 → planning_update → propose_handoff → update_ready → 빌드 → regression 통과 → deployed(v2).

### [ ] 8. docs/ops 회고 §3.1A — 상태 전이 로그 WS 항상 방출

- **내용**: 회고에서 "상태 전이가 발생할 때마다 WS로 이벤트 방출해 UI가 즉시 반영" 권고. 현재는 일부 전이만 방출.
- **관련 파일**:
  - `orchestrator/src/state-machine/state-machine.service.ts` — `transition()` 메서드
- **조치**: `StateMachineService.transition()`에 BuildGateway 주입, 모든 전이를 `{event_type: 'state_change', from, to, reason}` 이벤트로 emit. 프론트에서 `fetchProject` 폴링 대체.

### [ ] 9. ADR 0008 §D5 `change_summary` 필드 설계 판단 기록

- **내용**: ADR §D5는 propose_handoff에 `change_summary` 필드를 신설하라 제안. 실제 구현은 기존 `assumptions_made`에 변경 요약을 담도록 해서 스키마 확장을 피함.
- **조치**: ADR §D5에 "구현 판단: change_summary 신설 대신 assumptions_made 재활용"이라는 각주 추가. propose_handoff 스키마 안정성 유지를 위한 합리적 결정이므로 코드 변경 불필요.

---

## 회고 §9 후속 (2026-04-24, building-agent settings 누락 + 컨테이너 require cache 미스 사고에서 파생)

### [ ] 10. failure_classifier에 building-agent 자체 버그 카테고리 추가

- **내용**: `AttributeError` / `ImportError` / `ModuleNotFoundError` / `NameError` 등 building-agent 자체 코드 결함은 현재 `unknown`으로 분류돼 유저에게 "기획 보강하세요" 메시지 노출. 사실은 운영자가 코드를 고쳐야 하는 영역 — 유저는 할 수 있는 게 없다.
- **관련 파일**:
  - `building-agent/qa_supervisor.py` — failure classifier 위치
  - `orchestrator/src/agents/building.runner.ts` — handleExit에서 분류 결과 라우팅
  - 회고 §9.7 항목 1
- **조치**: classifier에 `infra_error_agent_bug` 카테고리 신설. building-agent stderr에서 Python `Traceback` 패턴 + 위 4개 예외 클래스 매칭. 매칭 시 유저 화면엔 "운영자에게 알림이 전송됐습니다. 기획 수정으로 해결되지 않습니다" 메시지 + "↻ 다시 빌드" CTA 제거. 운영자 알림 채널은 별도 (이번엔 회고 문서로 대체).

### [ ] 11. update 라인 retry 한계 — 같은 stack trace N회 차단

- **내용**: 첫 빌드 라인은 회고 §6의 "2회 연속 실패 시 CTA flip"이 있지만 update 라인엔 같은 안전장치 없음. 베키 사례에서 v2 빌드 3회 같은 `AttributeError`로 실패하는 동안 매번 retry 버튼이 활성화돼 유저가 의미 없는 재시도 가능했음.
- **관련 파일**:
  - `frontend/src/components/ProjectCard.tsx` (또는 BuildStatus) — retry CTA 표시 로직
  - `orchestrator/src/projects/projects.service.ts` `findOne` — last_bounce/failure_reason 응답에 "consecutive_same_error_count" 같은 필드 추가
  - 회고 §9.7 항목 2
- **조치**: 직전 N개 build의 stderr stack tail 정규화 비교. 동일 stack 2회 이상이면 retry CTA 비활성화 + "같은 에러가 반복되고 있어요. 운영자에게 알림이 전송됐습니다" 메시지. N=2 권장(첫 빌드 라인과 대칭).

### [ ] 12. update 빌드 실패 시 디스크 코드 cleanup or git rollback

- **내용**: 회고 §7의 `BuildingRunner.cleanupFailedContainer()`는 첫 빌드 라인 한정. update 라인은 previous 컨테이너 보존 불변식(§D4) 때문에 컨테이너 cleanup 안 함. **그런데 디스크 코드도 cleanup 안 됨** → 빌드가 phase 일부만 진행한 상태로 디스크에 변경이 남고, 이게 살아있는 v1 컨테이너의 require cache와 어긋난다(베키 사례 root cause B).
- **관련 파일**:
  - `building-agent/orchestrator.py` — phase 실패 시 정리
  - `orchestrator/src/agents/building.runner.ts` — handleExit update 라인 분기
  - 모노레포·git 도입(MEMORY 항목 "ax-builder GitHub 방향")과 자연스럽게 합류
  - 회고 §9.7 항목 3
- **조치 후보**:
  - (A) 빌드 시작 직전 `projects/<id>/.ax-build/pre-update-disk-backup/`에 source tree tar.gz 백업 → 실패 시 복원. PRD/DESIGN과 같은 D4-bis 백업 패턴의 코드 트리 확장.
  - (B) git 도입 시: 빌드 시작에서 `git checkout -b update-{build_id}` → 성공 시 main에 merge, 실패 시 브랜치 폐기 + main 그대로. **이 경로가 git 도입의 가장 명확한 첫 가치**.
- **권장**: B로 가되 PoC 단계에선 A로 임시 막기. git 도입은 별도 의사결정이라 시간 걸림.

---

## 우선순위 요약

1. **#1** (qa/update_qa state 전이) — 유저가 보는 UX 직결. 처리 시 #1만 별도 PR 가치 있음.
2. **#2 + #3** — PRD·ADR 문서 정합. 코드 1곳도 건드리지 않고 `.md` 수정만으로 끝. 같이 묶어 처리.
3. **#4 ~ #6** — 한 번에 정리 가능한 minor 정돈.
4. **#7 ~ #9** — 후속 작업. 필요할 때 개별 처리.
5. **#10 ~ #12** — 회고 §9 사고 후속. **#12가 가장 큰 영향**(메모리·디스크·DB 3자 일관성 invariant 정립). #10 #11은 단발 PR.
