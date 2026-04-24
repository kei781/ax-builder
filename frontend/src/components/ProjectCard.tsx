import { useNavigate } from 'react-router-dom';
import client from '../api/client';

// 배포된 앱 접속 URL에 쓸 호스트. `VITE_PROJECT_HOST` 환경변수로 덮어쓰기.
// 외부 IP(예: 221.150.9.241)나 도메인을 넣으면 그것으로, 없으면 localhost.
const PROJECT_HOST =
  (import.meta.env.VITE_PROJECT_HOST as string | undefined)?.trim() ||
  'localhost';

export type ProjectState =
  | 'draft'
  | 'planning'
  | 'plan_ready'
  | 'building'
  | 'qa'
  | 'awaiting_env'
  | 'env_qa'
  | 'deployed'
  | 'failed'
  | 'planning_update'
  | 'update_ready'
  | 'updating'
  | 'update_qa';

export interface ProjectCardProps {
  id: string;
  title: string;
  state: ProjectState;
  port: number | null;
  ownerName: string;
  myRole: 'owner' | 'editor' | 'viewer';
  locked_until?: string | null;
  created_at: string;
}

// ADR 0008 — 두 라인 색 체계 분리.
// 첫 빌드(회색·하늘·파랑·보라) vs 업데이트(인디고·민트·시안) — 유저가 색만 보고
// "지금 새로 만드는 중인지, 기존 앱 수정 중인지" 구분.
const stateConfig: Record<ProjectState, { label: string; color: string }> = {
  // 첫 빌드 라인
  draft: { label: '새 프로젝트', color: 'bg-gray-400' },
  planning: { label: '기획 중', color: 'bg-sky-500' },
  plan_ready: { label: '빌드 대기', color: 'bg-blue-500' },
  building: { label: '빌드 중', color: 'bg-blue-600' },
  qa: { label: '검증 중', color: 'bg-purple-500' },
  // env 사이드
  awaiting_env: { label: '설정 필요', color: 'bg-orange-500' },
  env_qa: { label: '환경 검증 중', color: 'bg-purple-500' },
  // 터미널
  deployed: { label: '운영 중', color: 'bg-emerald-500' },
  failed: { label: '실패', color: 'bg-red-500' },
  // 업데이트 라인 (인디고·민트·시안 계열)
  planning_update: { label: '수정 기획 중', color: 'bg-indigo-500' },
  update_ready: { label: '업데이트 대기', color: 'bg-teal-500' },
  updating: { label: '업데이트 중', color: 'bg-cyan-500' },
  update_qa: { label: '회귀 검증 중', color: 'bg-cyan-500' },
};

export default function ProjectCard({
  id,
  title,
  state,
  port,
  ownerName,
  myRole,
  locked_until,
}: ProjectCardProps) {
  const navigate = useNavigate();
  const { label, color } = stateConfig[state] || stateConfig.draft;
  const canEdit = myRole === 'owner' || myRole === 'editor';
  const isLocked = locked_until && new Date(locked_until) > new Date();

  const goChat = () => navigate(`/projects/${id}/chat`);
  const goBuild = () => navigate(`/projects/${id}/build`);
  const goEnv = () => navigate(`/projects/${id}/env`);

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl p-5 border border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700 transition-colors shadow-sm dark:shadow-none">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-gray-900 dark:text-white font-medium text-lg">{title}</h3>
          <p className="text-gray-500 text-sm">
            {myRole === 'owner' ? '나 (owner)' : `${ownerName} | 나: ${myRole}`}
          </p>
        </div>
        <span className={`${color} text-white text-xs px-2 py-1 rounded-full font-medium`}>
          {label}
        </span>
      </div>

      {port && state === 'deployed' && (
        <p className="text-gray-600 dark:text-gray-400 text-sm mb-3">
          🌐 {PROJECT_HOST}:{port}
          <a
            href={`http://${PROJECT_HOST}:${port}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-green-600 dark:text-green-400 hover:text-green-500 ml-2"
          >
            접속 →
          </a>
        </p>
      )}

      {/* 업데이트 라인: 기존 앱 URL 유지 노출 + 안심 문구 (ADR 0008 §D4) */}
      {port &&
        (state === 'planning_update' ||
          state === 'update_ready' ||
          state === 'updating' ||
          state === 'update_qa') && (
          <div className="mb-3">
            <p className="text-gray-600 dark:text-gray-400 text-sm">
              🌐 {PROJECT_HOST}:{port}
              <a
                href={`http://${PROJECT_HOST}:${port}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-green-600 dark:text-green-400 hover:text-green-500 ml-2"
              >
                접속 →
              </a>
            </p>
            {(state === 'updating' || state === 'update_qa') && (
              <p className="text-cyan-700 dark:text-cyan-300 text-xs mt-1">
                ↺ 업데이트 중 — 기존 앱은 계속 접속 가능합니다.
              </p>
            )}
          </div>
        )}

      {isLocked && (
        <p className="text-red-400 text-xs mb-3">프로젝트 잠금 중</p>
      )}

      <div className="flex gap-2 mt-3 flex-wrap items-center">
        {/* Draft / Planning → go to chat */}
        {(state === 'draft' || state === 'planning') && canEdit && (
          <button onClick={goChat} className="text-sm bg-blue-500/10 text-blue-400 px-3 py-1.5 rounded-lg hover:bg-blue-500/20 transition-colors">
            기획 계속
          </button>
        )}
        {/* Plan ready → can start build */}
        {state === 'plan_ready' && canEdit && (
          <>
            <button onClick={goChat} className="text-sm bg-blue-500/10 text-blue-400 px-3 py-1.5 rounded-lg hover:bg-blue-500/20 transition-colors">
              기획 보기
            </button>
            <button onClick={goBuild} className="text-sm bg-green-500/10 text-green-400 px-3 py-1.5 rounded-lg hover:bg-green-500/20 transition-colors">
              빌드 시작
            </button>
          </>
        )}
        {/* Building / QA → check status */}
        {(state === 'building' || state === 'qa') && (
          <button onClick={goBuild} className="text-sm bg-yellow-500/10 text-yellow-400 px-3 py-1.5 rounded-lg hover:bg-yellow-500/20 transition-colors">
            빌드 상태
          </button>
        )}
        {/* planning_update → 수정 기획 계속 */}
        {state === 'planning_update' && canEdit && (
          <button onClick={goChat} className="text-sm bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 px-3 py-1.5 rounded-lg hover:bg-indigo-500/20 transition-colors">
            수정 기획 계속
          </button>
        )}
        {/* update_ready → 업데이트 시작 */}
        {state === 'update_ready' && canEdit && (
          <>
            <button onClick={goChat} className="text-sm bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 px-3 py-1.5 rounded-lg hover:bg-indigo-500/20 transition-colors">
              수정 보기
            </button>
            <button onClick={goBuild} className="text-sm bg-teal-500/10 text-teal-600 dark:text-teal-400 px-3 py-1.5 rounded-lg hover:bg-teal-500/20 transition-colors">
              업데이트 시작
            </button>
          </>
        )}
        {/* updating / update_qa → 업데이트 상태 */}
        {(state === 'updating' || state === 'update_qa') && (
          <button onClick={goBuild} className="text-sm bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 px-3 py-1.5 rounded-lg hover:bg-cyan-500/20 transition-colors">
            업데이트 상태
          </button>
        )}
        {/* Awaiting env → input screen */}
        {state === 'awaiting_env' && canEdit && (
          <button onClick={goEnv} className="text-sm bg-orange-500/10 text-orange-500 px-3 py-1.5 rounded-lg hover:bg-orange-500/20 transition-colors">
            환경 설정
          </button>
        )}
        {/* env_qa → viewing in env page */}
        {state === 'env_qa' && canEdit && (
          <button onClick={goEnv} className="text-sm bg-purple-500/10 text-purple-400 px-3 py-1.5 rounded-lg hover:bg-purple-500/20 transition-colors">
            적용 진행 상태
          </button>
        )}
        {/* Deployed → env maintenance + restart + modify */}
        {state === 'deployed' && canEdit && (
          <>
            <button onClick={goEnv} className="text-sm bg-blue-500/10 text-blue-600 dark:text-blue-400 px-3 py-1.5 rounded-lg hover:bg-blue-500/20 transition-colors">
              ⚙ 환경 설정
            </button>
            {myRole === 'owner' && (
              <button
                onClick={async () => {
                  if (!confirm(`'${title}' 프로젝트를 재시작하시겠습니까?\n약 5~10초 동안 서비스가 잠시 끊깁니다.`)) return;
                  try {
                    const res = await client.post(`/projects/${id}/restart`);
                    if (res.data.accepted) {
                      alert('재시작을 시작했습니다. 잠시 뒤 상태가 갱신됩니다.');
                    } else {
                      alert(res.data.message ?? '재시작 요청됨');
                    }
                  } catch (err: unknown) {
                    const e = err as { response?: { data?: { message?: string } } };
                    alert(`재시작 실패: ${e.response?.data?.message ?? '알 수 없는 오류'}`);
                  }
                }}
                className="text-sm bg-orange-500/10 text-orange-600 dark:text-orange-400 px-3 py-1.5 rounded-lg hover:bg-orange-500/20 transition-colors"
              >
                🔄 재시작
              </button>
            )}
            <button onClick={goChat} className="text-sm bg-purple-500/10 text-purple-400 px-3 py-1.5 rounded-lg hover:bg-purple-500/20 transition-colors">
              수정 요청
            </button>
          </>
        )}
        {/* Failed → 같은 기획으로 다시 빌드 + 기획 수정 (둘 다 제공) */}
        {state === 'failed' && canEdit && (
          <>
            <button
              onClick={async () => {
                try {
                  await client.post(`/projects/${id}/build/retry`);
                  navigate(`/projects/${id}/build`);
                } catch (err: unknown) {
                  const e = err as { response?: { data?: { message?: string } } };
                  alert(
                    `재빌드 실패: ${e.response?.data?.message ?? '알 수 없는 오류'}\n\n기획 대화로 돌아가서 propose_handoff를 다시 호출해주세요.`,
                  );
                }
              }}
              className="text-sm bg-red-500/10 text-red-600 dark:text-red-400 px-3 py-1.5 rounded-lg hover:bg-red-500/20 transition-colors"
            >
              ↻ 다시 빌드
            </button>
            <button
              onClick={goChat}
              className="text-sm bg-blue-500/10 text-blue-400 px-3 py-1.5 rounded-lg hover:bg-blue-500/20 transition-colors"
            >
              기획 수정
            </button>
          </>
        )}
        {/* Viewer badge */}
        {!canEdit && (
          <button onClick={goChat} className="text-sm text-gray-500 bg-gray-100 dark:bg-gray-800 px-3 py-1.5 rounded-lg">
            보기 전용
          </button>
        )}
        {/* Delete (owner only) */}
        {myRole === 'owner' && (
          <button
            onClick={async () => {
              if (!confirm(`'${title}' 프로젝트를 삭제하시겠습니까?`)) return;
              try {
                await client.delete(`/projects/${id}`);
                window.location.reload();
              } catch {
                alert('삭제 실패');
              }
            }}
            className="text-sm bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 px-3 py-1.5 rounded-lg hover:bg-red-500/20 hover:text-red-500 transition-colors ml-auto"
          >
            삭제
          </button>
        )}
      </div>
    </div>
  );
}
