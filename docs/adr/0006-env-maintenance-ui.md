# ADR 0006: Env 유지보수 UI — 2-모드 편집 + 프로젝트 재시작 + 밸리데이션

- **상태**: Accepted
- **일시**: 2026-04-19
- **관련**: PRD §5.7, §9, DESIGN.md §4, ADR 0004, 0005

## 배경

ADR 0005에서 env를 "배포 후 선택적 향상"으로 재정의했다. 그러면 env UI는 이제 **1회성 블로킹 입력 창**이 아니라 **배포된 프로젝트의 지속적 관리 화면**이어야 한다.

구체적으로 오너가 원할 상황:
- 첫 배포 직후 실제 키 입력해서 mock을 real로 전환
- 며칠 뒤 키가 만료돼서 값만 갱신 (재배포 불필요)
- 잘못된 값 입력 후 즉시 정정
- 의심되는 동작 → env 확인 → 필요 시 재시작

지금 `EnvInput.tsx`는 **초기 `awaiting_env` 전용 원샷 입력**으로만 설계됐다. 필드별 독립 수정, 언제든 재진입, 값 삭제, 재시작 같은 운영 시나리오가 모두 누락.

또 입력 검증이 거의 없다. 유저가 `STRIPE_SECRET_KEY`에 빈 문자열이나 공백, 포맷에 맞지 않는 문자열을 넣어도 서버가 받아들인 뒤 컨테이너가 죽고 나서야 failure 표시 — 지연된 피드백.

## 결정

### D1. EnvInput 2-모드

한 컴포넌트가 상황에 따라 동작 분기:

| 모드 | 진입 시점 | 동작 |
|---|---|---|
| **초기 설정** (setup) | project.state가 `awaiting_env`일 때 — 사실상 ADR 0005 이후로는 거의 쓰이지 않지만 호환 유지 | 필수 섹션 원샷 입력 → 적용 시 자동 env_qa → deployed |
| **유지보수** (maintenance) | project.state가 `deployed` 이상일 때 | 필드별 독립 편집. 저장 버튼 2종: ["💾 저장"](DB만) / ["💾 저장 후 재시작"](DB + docker restart + 헬스체크) |

모드 감지: 프론트가 프로젝트 state로 판단. 서버 응답은 동일한 `EnvVarView` 리스트.

### D2. 필드별 CRUD

- **입력/수정**: `PUT /api/projects/:id/env` `{ vars: [{key, value}] }` — 부분 업데이트 허용. 페이로드에 없는 키는 건드리지 않음.
- **삭제**: 값 비우기는 value에 빈 문자열. `required` 변수를 비우면 400. value 필드에 `null`을 보내면 row에서 value_ciphertext 제거 + required 체크 후 400 여부 결정. (MVP에선 빈 문자열만 지원, `null` 시맨틱은 Phase 6+)
- **행 자체 삭제**는 불가 — `.env.example`이 원천이기 때문. 빌드가 다시 돌면서 sync되면 그때 제거.

### D3. 재시작 — **recreate 경로로 변경 (2026-04-20)**

| API | 메소드 | 경로 | 권한 |
|---|---|---|---|
| restart | POST | `/api/projects/:id/restart` | **owner만** |

동작:
1. 컨테이너 존재 확인
2. `project_env_vars` 전체 복호화 → env dict 구성 (`envs.service.resolveAllForContainer`)
3. `.env` 파일 재기록 (dev 편의·폴백용)
4. **기존 컨테이너 제거 → 새 env dict로 `createContainer` 재호출 → start** (= recreate).
5. 헬스체크 60초 폴링 (HTTP HEAD)
6. 통과 → `container_id` 갱신 + state=`deployed` / 실패 → classifier 경유 handleFailure → **이전 컨테이너는 이미 제거됐지만 state=`deployed` 유지** (값만 되돌리고 다시 `/restart` 가능)

**왜 restart가 아니라 recreate인가?**

초기 MVP는 `docker restart <id>`로 구현했지만, Docker의 `Env` 배열은 **`createContainer` 시점에 고정**되고 이후 restart로는 갱신되지 않는다. 결과적으로 유저가 env를 수정·저장·재시작해도 **새 env가 컨테이너에 반영되지 않음** — 생성된 앱은 이전 값(또는 값 없음)을 계속 봤다.

실제로 ADMIN_PASSWORD를 "1111"로 설정 → `/restart` → 로그인 시 "비밀번호 틀림" 사례 발생. 원인 추적: 앱이 `require('dotenv').config()`를 안 불러서 `.env` 파일이 있어도 `process.env`로 못 올라가고, docker Env에도 없어서 프로세스엔 사실상 변수가 없음.

**수정 방향**:
- **Docker Env 주입** — `createContainer(extraEnv)` 파라미터로 DB의 모든 값을 `Env[]`에 포함. 앱이 dotenv를 쓰든 안 쓰든 `process.env`에서 바로 읽힘.
- **restart → recreate** — 새 env를 적용하려면 재생성 필수. 호스트 포트(`projects.port`)는 유지, `container_id`만 갱신.
- **트레이드오프**: npm install이 anonymous volume에서 다시 돌아야 해서 헬스체크 타임아웃을 10s → 60s로 상향. recreate라는 이름이 약간 무겁지만 유저 관점에선 "저장 후 재시작" 한 번의 액션이라 UX는 동일.

### D3.1 fresh deploy도 같은 경로

빌드 완료 직후 첫 배포(`env-deploy.freshDeploy`)도 똑같이 `envs.resolveAllForContainer` → `docker.createContainer(extraEnv)` 경유. 이전엔 `writeDotenv`만 하고 Docker Env엔 안 넘겨서 같은 잠재 버그가 있었음.

**롤백 시맨틱**: 재시작이 실패해도 **컨테이너 제거 안 함**. 직전 바이너리/코드는 그대로 있어 재시도 가능. env 변경이 원인이면 되돌릴 여지 남김.

UI: "정말 재시작하시겠습니까? 약 5~10초 서비스가 끊깁니다." 확인 모달.

### D4. 밸리데이션

**원천**: `.env.example`의 메타라인.

```
# DATABASE_URL
# 설명: 외부 PostgreSQL URL
# 예시: postgres://user:pass@host:5432/db
# 필수 여부: required
# 주입: user-required
# 패턴: ^postgres(ql)?:\/\/
# 길이: 10-500
DATABASE_URL=
```

파서(`env-parser.ts`) 확장:
- `# 패턴:` / `# pattern:` → `pattern: string`
- `# 길이:` / `# length:` → `min_length` / `max_length` (예: `10-500` 또는 단일 `>=10`)

서버 검증:
- PUT/PATCH 시 각 value 대해 `pattern` / 길이 체크. 실패 시 400 + `{errors: [{key, reason}]}`.
- `required` 필드 빈값 거부.

프론트 검증:
- 입력 필드 blur·change 시 동일 로직 인라인 실행. 실패 시 빨간 테두리 + "잘못된 형식입니다. 예: sk_test_...".
- 서버 400 응답도 동일 UI에 매핑.

패턴이 없는 변수는 **검증 건너뜀** — Claude Code가 모르는 서비스에 대해 과잉 제약 걸지 않도록.

### D5. 권한

| 작업 | owner | editor | viewer |
|---|---|---|---|
| env 조회 (마스킹) | ✅ | ✅ | ❌ |
| env 입력/수정 | ✅ | ✅ | ❌ |
| env 삭제(값 비우기) | ✅ | ✅ | ❌ |
| 재시작 | ✅ | ❌ | ❌ |

편집은 협업자(editor)도 가능하지만 **재시작처럼 서비스 중단이 있는 액션은 owner에만**. 위험도 차이 반영.

### D6. 상태 머신 반영

- `deployed → deployed` 자가 전이 추가: env 저장(재시작 없음) 시. 컨테이너 그대로, DB만 업데이트.
- `deployed → env_qa → deployed`: "저장 후 재시작" 시. 재시작 QA 실패는 `awaiting_env`로 안 감 — **`deployed` 그대로 유지 + 에러 토스트**. (이전 버전은 여전히 돌고 있으므로 롤백 무료.)
- `env_qa → modifying`: real 전환 후 통합 버그로 판정되면 채팅 세션으로 진입(ADR 0005).

## 대안

- **A. env 수정은 항상 재시작 강제**: 단순하지만 과함. 토큰 교체 같은 간단 작업에 5초 서비스 중단은 불필요.
- **B. 재시작 대신 컨테이너 재생성**: 무거움. 빌드 아니고 env 갱신이면 `docker restart`로 충분.
- **C. 밸리데이션을 전부 서버 측에만**: UX 피드백이 늦어짐. 클라이언트·서버 2중 검증이 옳음.
- **D. 재시작 권한을 editor에도 부여**: 서비스 중단 의사결정은 오너의 책임 영역. editor는 값 제안까지.

## 결과

**장점**
- 운영 시나리오(키 만료, 오타 정정, 의심 동작 확인) 전부 UI에서 완결.
- 재시작이 가벼워 부담 없이 사용.
- 밸리데이션으로 "썼는데 죽었어" 사례 감소.

**단점 / 주의**
- 프론트 복잡도 증가 — 2모드 분기, 필드별 상태 관리, 검증 상태.
- `.env.example` 메타라인 규격이 늘어나서 Claude Code 프롬프트 부담 증가.
- 재시작 권한을 owner로 좁혔으므로, 1인 editor 팀 운영 시 오너 부재면 재시작 불가 — 문서화 필요.

## 연관 구현

**Phase 6 예정**

- `orchestrator/src/envs/env-parser.ts` — `pattern` / `min_length` / `max_length` 추출
- `orchestrator/src/envs/entities/project-env-var.entity.ts` — pattern/min_length/max_length 컬럼
- `orchestrator/src/envs/envs.service.ts` — 서버 측 밸리데이션 + 부분 업데이트 보장
- `orchestrator/src/envs/envs.controller.ts` — 필요 시 PATCH 분리 검토 (MVP는 PUT 부분 업데이트로 통합)
- `orchestrator/src/projects/projects.controller.ts` — `POST /restart` 엔드포인트 owner 가드 + docker.restartContainer + 헬스체크
- `frontend/src/pages/EnvInput.tsx` — 2모드 리팩터 + 인라인 검증
- `frontend/src/components/ProjectCard.tsx` — `deployed` 카드에 "⚙ 환경 설정" + "🔄 재시작" 버튼
- 재시작 확인 모달 (재사용 가능한 `ConfirmDialog` 신설 검토)

## 교차 참조

- **ADR 0005** — 이 UI가 전제. env를 언제든 편집·재시작할 수 있어야 mock-first 플로우가 완결.
- **ADR 0004** — 밸리데이션 메타라인은 `.env.example` 규격의 연장.
- **ADR 0002** — 재시작 실패 시 FailureClassifier 활용 여부 검토(우선순위 낮음).
