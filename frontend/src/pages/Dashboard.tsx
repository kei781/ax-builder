import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import ProjectCard from '../components/ProjectCard';
import type { ProjectCardProps } from '../components/ProjectCard';
import client from '../api/client';
import ThemeToggle from '../components/ThemeToggle';
import InfraStatus from '../components/InfraStatus';

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectCardProps[]>([]);
  const [publicProjects, setPublicProjects] = useState<ProjectCardProps[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [mine, pub] = await Promise.all([
          client.get('/projects'),
          client.get('/projects/public').catch(() => ({ data: [] })),
        ]);
        setProjects(mine.data);
        setPublicProjects(pub.data);
      } catch (err) {
        console.error('Failed to fetch projects:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleCreate = async () => {
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      const res = await client.post('/projects', { title: newTitle });
      setShowNewModal(false);
      setNewTitle('');
      navigate(`/projects/${res.data.id}/chat`);
    } catch {
      alert('프로젝트 생성에 실패했습니다.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <header className="border-b border-gray-200 dark:border-gray-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-gray-900 dark:text-white text-xl font-bold">ax-builder</h1>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          {user?.avatar_url && (
            <img src={user.avatar_url} alt="" className="w-8 h-8 rounded-full" />
          )}
          <span className="text-gray-700 dark:text-gray-300 text-sm">{user?.name}</span>
          <button
            onClick={logout}
            className="text-gray-500 hover:text-gray-900 dark:hover:text-gray-300 text-sm"
          >
            로그아웃
          </button>
        </div>
      </header>

      <InfraStatus />

      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-gray-900 dark:text-white text-2xl font-semibold">내 프로젝트</h2>
          <button
            onClick={() => setShowNewModal(true)}
            className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            + 새 프로젝트
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500" />
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-gray-500 text-lg mb-2">아직 프로젝트가 없습니다.</p>
            <p className="text-gray-400 dark:text-gray-600 text-sm">
              새 프로젝트를 만들어 아이디어를 제품으로 만들어보세요!
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
            {projects.map((p) => (
              <ProjectCard key={p.id} {...p} />
            ))}
          </div>
        )}

        {!loading && publicProjects.length > 0 && (
          <div className="mt-12">
            <div className="flex items-center gap-3 mb-6">
              <h2 className="text-gray-900 dark:text-white text-xl font-semibold">다른 프로젝트</h2>
              <span className="text-xs text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
                {publicProjects.length}개
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
              {publicProjects.map((p) => (
                <ProjectCard key={p.id} {...p} />
              ))}
            </div>
          </div>
        )}
      </main>

      {showNewModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-md mx-4 shadow-xl">
            <h3 className="text-gray-900 dark:text-white text-lg font-medium mb-4">새 프로젝트</h3>
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="프로젝트 이름을 입력하세요"
              className="w-full bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white rounded-xl px-4 py-3 text-sm border border-gray-200 dark:border-gray-700 focus:border-green-500 focus:outline-none mb-4"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setShowNewModal(false); setNewTitle(''); }}
                className="text-gray-500 hover:text-gray-900 dark:hover:text-white px-4 py-2 text-sm"
              >
                취소
              </button>
              <button
                onClick={handleCreate}
                disabled={!newTitle.trim() || creating}
                className="bg-green-600 hover:bg-green-500 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white px-4 py-2 rounded-xl text-sm font-medium"
              >
                {creating ? '생성 중...' : '만들기'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
