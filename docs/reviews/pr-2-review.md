# PR #2 리뷰 (feat/readiness-sidebar)

리뷰 일자: 2026-04-16

## 결론
- **요청 변경(Request changes)** 권장.

## 주요 이슈

### 1) 빌드 버튼 활성 조건이 백엔드 상태 머신과 불일치 (Blocker)
- 증상: `readiness.can_build`만으로 빌드 버튼이 켜지면, 프로젝트 상태가 `plan_ready`가 아닐 때도 빌드 API 호출이 가능해집니다.
- 영향: 사용자는 버튼이 활성화되어 있어도 클릭 즉시 서버 에러를 받는 UX 오류를 겪습니다.
- 권장 수정:
  - 버튼 표시/활성화 조건을 `project.state === 'plan_ready'`와 함께 검사
  - `handleBuild` 내부에서도 방어적으로 동일 조건 재검증

## 확인된 사항
- 최신 코드에서는 `const canBuild = project?.state === 'plan_ready';` 조건으로 빌드 진입을 제한하고 있어, 위 이슈는 해소된 형태입니다.

## 코멘트
- `evaluate_readiness` 추가 및 사이드바 복원 자체는 UX 개선 방향이 맞습니다.
- 다만 액션 가능 상태를 도메인 상태 머신과 1:1로 맞추는 원칙은 반드시 지켜야 합니다.
