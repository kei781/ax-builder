import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import client from '../api/client';

export interface ProjectCardProps {
  id: string;
  title: string;
  status: 'scoring' | 'building' | 'qa' | 'awaiting_env' | 'deployed' | 'failed' | 'stopped';
  score: number;
  port: number | null;
  ownerName: string;
  myRole: 'owner' | 'editor' | 'viewer';
  missing_items?: string[];
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

const MAX_VISIBLE = 3;

export default function ProjectCard({
  id,
  title,
  status,
  score,
  port,
  ownerName,
  myRole,
  missing_items = [],
}: ProjectCardProps) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const { label, color } = statusConfig[status] || statusConfig.stopped;

  const visibleItems = missing_items.slice(0, MAX_VISIBLE);
  const hasMissing = visibleItems.length > 0 && (status === 'scoring' || status === 'failed');

  return (
    <div className="relative">
      {/* 메인 카드 */}
      <div className="bg-white dark:bg-gray-900 rounded-xl p-5 border border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700 transition-colors relative z-10 shadow-sm dark:shadow-none">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-gray-900 dark:text-white font-medium text-lg">{title}</h3>
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
          <p className="text-gray-600 dark:text-gray-400 text-sm mb-3">
            🐳 Docker :{port}
            {status === 'deployed' && (
              <a
                href={`http://localhost:${port}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-green-600 dark:text-green-400 hover:text-green-500 ml-2"
              >
                접속 →
              </a>
            )}
          </p>
        )}

        {status === 'scoring' && (
          <p className="text-gray-500 text-sm mb-3">스코어: {score}/1000</p>
        )}

        <div className="flex gap-2 mt-3 flex-wrap items-center">
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
          {status === 'failed' && (myRole === 'owner' || myRole === 'editor') && (
            <>
              <button
                onClick={() => navigate(`/projects/${id}/chat`)}
                className="text-sm bg-blue-500/10 text-blue-400 px-3 py-1.5 rounded-lg hover:bg-blue-500/20 transition-colors"
              >
                PRD 수정
              </button>
              <button
                onClick={async () => {
                  if (!confirm('다시 빌드를 시작하시겠습니까?')) return;
                  try {
                    await client.post(`/projects/${id}/build`);
                    navigate(`/projects/${id}/build`);
                  } catch {
                    alert('재빌드 시작 실패');
                  }
                }}
                className="text-sm bg-green-500/10 text-green-400 px-3 py-1.5 rounded-lg hover:bg-green-500/20 transition-colors"
              >
                재빌드
              </button>
            </>
          )}
          {myRole === 'viewer' && (
            <span className="text-sm text-gray-500 bg-gray-100 dark:bg-gray-800 px-3 py-1.5 rounded-lg">
              보기전용
            </span>
          )}
          {myRole === 'owner' && (
            <button
              onClick={async () => {
                if (!confirm(`'${title}' 프로젝트를 삭제하시겠습니까? 복구할 수 없습니다.`)) return;
                try {
                  await client.delete(`/projects/${id}`);
                  window.location.reload();
                } catch {
                  alert('삭제 실패');
                }
              }}
              className="text-sm bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 px-3 py-1.5 rounded-lg hover:bg-red-500/20 hover:text-red-500 dark:hover:text-red-400 transition-colors ml-auto"
            >
              삭제
            </button>
          )}
        </div>
      </div>

      {/* 하단에 깔린 카드 (보완 필요 항목) — 클릭하면 펼쳐짐 */}
      {hasMissing && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="block text-left bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-750 border border-gray-200 dark:border-gray-700 border-t-0 rounded-b-xl overflow-hidden transition-all duration-300 -mt-3 mx-auto w-[calc(100%-24px)]"
        >
          {/* 항상 보이는 헤더 */}
          <div className="flex items-center justify-between px-5 pt-4 pb-2.5">
            <span className="text-gray-700 dark:text-gray-300 text-xs font-semibold tracking-wider flex items-center gap-2">
              <span className="text-yellow-500 dark:text-yellow-400">⚠️</span>
              보완 필요 항목 <span className="text-yellow-600 dark:text-yellow-400">+{visibleItems.length}</span>
            </span>
            <span
              className={`text-gray-400 dark:text-gray-500 text-xs transition-transform ${expanded ? 'rotate-180' : ''}`}
            >
              ▾
            </span>
          </div>

          {/* 펼쳤을 때만 보이는 내용 */}
          <div
            className={`overflow-hidden transition-all duration-300 ${
              expanded ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'
            }`}
          >
            <ul className="space-y-2 px-5 pb-4 pt-1">
              {visibleItems.map((item, i) => (
                <li
                  key={i}
                  className="text-gray-800 dark:text-gray-200 text-sm flex gap-2 leading-snug"
                >
                  <span className="text-yellow-500 dark:text-yellow-400 font-bold shrink-0">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </button>
      )}
    </div>
  );
}
