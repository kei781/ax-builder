import { useNavigate } from 'react-router-dom';
import client from '../api/client';

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
  | 'modifying';

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

const stateConfig: Record<ProjectState, { label: string; color: string }> = {
  draft: { label: '새 프로젝트', color: 'bg-gray-400' },
  planning: { label: '기획 중', color: 'bg-blue-500' },
  plan_ready: { label: '빌드 준비', color: 'bg-green-500' },
  building: { label: '빌드 중', color: 'bg-yellow-500' },
  qa: { label: 'QA 중', color: 'bg-yellow-500' },
  awaiting_env: { label: '설정 필요', color: 'bg-orange-500' },
  env_qa: { label: '환경 검증 중', color: 'bg-purple-500' },
  deployed: { label: '운영 중', color: 'bg-emerald-500' },
  failed: { label: '실패', color: 'bg-red-500' },
  modifying: { label: '수정 중', color: 'bg-purple-500' },
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
          🌐 localhost:{port}
          <a
            href={`http://localhost:${port}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-green-600 dark:text-green-400 hover:text-green-500 ml-2"
          >
            접속 →
          </a>
        </p>
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
        {/* Deployed → view app + modify */}
        {state === 'deployed' && canEdit && (
          <button onClick={goChat} className="text-sm bg-purple-500/10 text-purple-400 px-3 py-1.5 rounded-lg hover:bg-purple-500/20 transition-colors">
            수정 요청
          </button>
        )}
        {/* Failed → retry from planning */}
        {state === 'failed' && canEdit && (
          <button onClick={goChat} className="text-sm bg-blue-500/10 text-blue-400 px-3 py-1.5 rounded-lg hover:bg-blue-500/20 transition-colors">
            기획 수정
          </button>
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
