import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import ProjectCard from '../components/ProjectCard';
import client from '../api/client';
import InfraStatus from '../components/InfraStatus';

interface ProjectData {
  id: string;
  title: string;
  status:
    | 'scoring'
    | 'building'
    | 'qa'
    | 'awaiting_env'
    | 'deployed'
    | 'failed'
    | 'stopped';
  score: number;
  port: number | null;
  ownerName: string;
  myRole: 'owner' | 'editor' | 'viewer';
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchProjects = async () => {
    try {
      const res = await client.get('/projects');
      setProjects(res.data);
    } catch (err) {
      console.error('Failed to fetch projects:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const handleCreate = async () => {
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      const res = await client.post('/projects', { title: newTitle });
      setShowNewModal(false);
      setNewTitle('');
      navigate(`/projects/${res.data.id}/chat`);
    } catch (err) {
      console.error('Failed to create project:', err);
      alert('프로젝트 생성에 실패했습니다.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950">
      <InfraStatus />
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-white text-xl font-bold">ax-builder</h1>
        <div className="flex items-center gap-3">
          {user?.avatar_url && (
            <img
              src={user.avatar_url}
              alt=""
              className="w-8 h-8 rounded-full"
            />
          )}
          <span className="text-gray-300 text-sm">{user?.name}</span>
          <button
            onClick={logout}
            className="text-gray-500 hover:text-gray-300 text-sm"
          >
            로그아웃
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-white text-2xl font-semibold">내 프로젝트</h2>
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
            <p className="text-gray-500 text-lg mb-2">
              아직 프로젝트가 없습니다.
            </p>
            <p className="text-gray-600 text-sm">
              새 프로젝트를 만들어 아이디어를 제품으로 만들어보세요!
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((p) => (
              <ProjectCard key={p.id} {...p} />
            ))}
          </div>
        )}
      </main>

      {/* New Project Modal */}
      {showNewModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-900 rounded-2xl p-6 w-full max-w-md mx-4">
            <h3 className="text-white text-lg font-medium mb-4">
              새 프로젝트
            </h3>
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="프로젝트 이름을 입력하세요"
              className="w-full bg-gray-800 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 focus:border-green-500 focus:outline-none mb-4"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowNewModal(false);
                  setNewTitle('');
                }}
                className="text-gray-400 hover:text-white px-4 py-2 text-sm transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleCreate}
                disabled={!newTitle.trim() || creating}
                className="bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
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
