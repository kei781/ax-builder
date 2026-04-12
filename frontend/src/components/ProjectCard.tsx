import { useNavigate } from 'react-router-dom';

export interface ProjectCardProps {
  id: string;
  title: string;
  status: 'scoring' | 'building' | 'qa' | 'awaiting_env' | 'deployed' | 'failed' | 'stopped';
  score: number;
  port: number | null;
  ownerName: string;
  myRole: 'owner' | 'editor' | 'viewer';
}

const statusConfig: Record<string, { label: string; color: string }> = {
  scoring: { label: '기획 중', color: 'bg-blue-500' },
  building: { label: '빌드 중', color: 'bg-yellow-500' },
  qa: { label: 'QA 중', color: 'bg-yellow-500' },
  awaiting_env: { label: 'ENV 입력 대기', color: 'bg-orange-500' },
  deployed: { label: 'Running', color: 'bg-green-500' },
  failed: { label: 'Failed', color: 'bg-red-500' },
  stopped: { label: 'Stopped', color: 'bg-gray-500' },
};

export default function ProjectCard({
  id,
  title,
  status,
  score,
  port,
  ownerName,
  myRole,
}: ProjectCardProps) {
  const navigate = useNavigate();
  const { label, color } = statusConfig[status] || statusConfig.stopped;

  return (
    <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 hover:border-gray-700 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-white font-medium text-lg">{title}</h3>
          <p className="text-gray-500 text-sm">
            {myRole === 'owner'
              ? '나 (owner)'
              : `${ownerName} | 나: ${myRole}`}
          </p>
        </div>
        <span
          className={`${color} text-white text-xs px-2 py-1 rounded-full font-medium`}
        >
          {label}
        </span>
      </div>

      {port && (
        <p className="text-gray-400 text-sm mb-3">
          🐳 Docker :{port}
          {status === 'deployed' && (
            <a
              href={`http://localhost:${port}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-green-400 hover:text-green-300 ml-2"
            >
              접속 →
            </a>
          )}
        </p>
      )}

      {status === 'scoring' && (
        <p className="text-gray-500 text-sm mb-3">스코어: {score}/1000</p>
      )}

      <div className="flex gap-2 mt-3">
        {status === 'scoring' && (
          <button
            onClick={() => navigate(`/projects/${id}/chat`)}
            className="text-sm bg-blue-500/10 text-blue-400 px-3 py-1.5 rounded-lg hover:bg-blue-500/20 transition-colors"
          >
            기획 계속
          </button>
        )}
        {status === 'deployed' && (myRole === 'owner' || myRole === 'editor') && (
          <>
            <button
              onClick={() => navigate(`/projects/${id}/chat?type=bug_report`)}
              className="text-sm bg-red-500/10 text-red-400 px-3 py-1.5 rounded-lg hover:bg-red-500/20 transition-colors"
            >
              버그 리포트
            </button>
            <button
              onClick={() => navigate(`/projects/${id}/chat?type=improvement`)}
              className="text-sm bg-purple-500/10 text-purple-400 px-3 py-1.5 rounded-lg hover:bg-purple-500/20 transition-colors"
            >
              서비스 개선
            </button>
          </>
        )}
        {status === 'building' && (
          <button
            onClick={() => navigate(`/projects/${id}/build`)}
            className="text-sm bg-yellow-500/10 text-yellow-400 px-3 py-1.5 rounded-lg hover:bg-yellow-500/20 transition-colors"
          >
            빌드 상태 보기
          </button>
        )}
        {myRole === 'viewer' && (
          <span className="text-sm text-gray-500 bg-gray-800 px-3 py-1.5 rounded-lg">
            보기전용
          </span>
        )}
      </div>
    </div>
  );
}
