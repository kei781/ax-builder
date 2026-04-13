import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import BuildLog from '../components/BuildLog';
import ChatMessage from '../components/ChatMessage';
import { useWebSocket } from '../hooks/useWebSocket';
import client from '../api/client';

const steps = [
  { key: 'setup', label: '환경 준비' },
  { key: 'coding', label: '코드 생성' },
  { key: 'qa', label: 'QA 검증' },
  { key: 'deploy', label: '배포' },
];

type ProjectStatus = 'building' | 'qa' | 'deployed' | 'failed' | string;
type Tab = 'build' | 'chat';

export default function BuildStatus() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { connected, progress, lastEvent, logs: wsLogs } = useWebSocket(id);
  const [localLogs, setLocalLogs] = useState<string[]>([]);
  const logs = [...localLogs, ...wsLogs];
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>('building');
  const [port, setPort] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [tab, setTab] = useState<Tab>('build');
  const [chatMessages, setChatMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [docs, setDocs] = useState<{ prd: string | null; design: string | null; claude: string | null; project_path: string | null }>({
    prd: null,
    design: null,
    claude: null,
    project_path: null,
  });
  const [docsLoading, setDocsLoading] = useState(false);
  const [showDoc, setShowDoc] = useState<null | 'prd' | 'design' | 'claude'>(null);
  const startTime = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!id) return;
    const poll = async () => {
      try {
        const res = await client.get(`/projects/${id}/build/status`);
        setProjectStatus(res.data.status);
        if (res.data.port) setPort(res.data.port);
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [id]);

  useEffect(() => {
    if (lastEvent === 'build_complete') setProjectStatus('deployed');
    else if (lastEvent === 'build_failed') setProjectStatus('failed');
  }, [lastEvent]);

  useEffect(() => {
    if (progress?.current_task) {
      setLocalLogs((prev) => [...prev, `▸ ${progress.current_task}`]);
    }
  }, [progress]);

  // 로컬 프로젝트 문서 (PRD.md / DESIGN.md / CLAUDE.md) 로드
  // 빌드 진행 중이면 10초마다 갱신, 완료/실패 후엔 1회만
  useEffect(() => {
    if (!id) return;
    const load = async () => {
      setDocsLoading(true);
      try {
        const res = await client.get(`/projects/${id}/build/docs`);
        setDocs(res.data);
      } catch {
        /* ignore */
      } finally {
        setDocsLoading(false);
      }
    };
    load();
    const active = projectStatus === 'building' || projectStatus === 'qa';
    if (!active) return;
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [id, projectStatus]);

  // 채팅 탭 전환 시 히스토리 로드 (최초 1회)
  useEffect(() => {
    if (tab !== 'chat' || !id || chatMessages.length > 0) return;
    setChatLoading(true);
    client
      .get(`/projects/${id}/chat/history?type=scoring`)
      .then((res) => setChatMessages(res.data.messages || []))
      .catch(() => setChatMessages([]))
      .finally(() => setChatLoading(false));
  }, [tab, id, chatMessages.length]);

  const currentPhase = progress?.phase || (
    projectStatus === 'deployed' ? 'deploy' :
    projectStatus === 'qa' ? 'qa' :
    projectStatus === 'failed' ? 'deploy' : 'setup'
  );
  const currentStepIdx = steps.findIndex((s) => s.key === currentPhase);
  const isComplete = projectStatus === 'deployed';
  const isFailed = projectStatus === 'failed';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <header className="border-b border-gray-200 dark:border-gray-800 px-6 py-4 flex items-center gap-4">
        <a href="/" className="text-gray-500 hover:text-gray-900 dark:hover:text-white">
          ← 대시보드
        </a>
        <h1 className="text-gray-900 dark:text-white font-medium">빌드 진행 상태</h1>
        {tab === 'build' && (
          <span
            className={`text-xs px-2 py-1 rounded-full ${
              connected
                ? 'bg-green-500/10 text-green-400'
                : 'bg-gray-200 dark:bg-gray-800 text-gray-500'
            }`}
          >
            {connected ? '실시간 연결' : 'API 폴링'}
          </span>
        )}
        <span className="text-gray-500 text-xs ml-auto">
          경과: {Math.floor(elapsed / 60)}분 {elapsed % 60}초
        </span>
      </header>

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-800 px-6">
        <div className="max-w-4xl mx-auto flex gap-1">
          <button
            onClick={() => setTab('build')}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'build'
                ? 'border-green-500 text-gray-900 dark:text-white'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            빌드 진행 상태
          </button>
          <button
            onClick={() => setTab('chat')}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'chat'
                ? 'border-green-500 text-gray-900 dark:text-white'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            기획 채팅 내역
          </button>
        </div>
      </div>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {tab === 'build' && (
          <>
            {/* 완료/실패 배너 */}
            {isComplete && (
              <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4 mb-8 flex items-center justify-between">
                <div>
                  <p className="text-green-400 font-medium">빌드 완료!</p>
                  {port && (
                    <a
                      href={`http://localhost:${port}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-green-300 text-sm hover:underline"
                    >
                      http://localhost:{port} 에서 접속 →
                    </a>
                  )}
                </div>
                <button
                  onClick={() => navigate('/')}
                  className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-xl text-sm"
                >
                  대시보드로
                </button>
              </div>
            )}

            {isFailed && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-8">
                <p className="text-red-400 font-medium">빌드 실패</p>
                <p className="text-red-300/70 text-sm mt-1">
                  AI가 3회 재시도했으나 해결하지 못했습니다. PRD를 수정하고 다시 시도해주세요.
                </p>
                <button
                  onClick={() => navigate(`/projects/${id}/chat`)}
                  className="mt-3 bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-xl text-sm"
                >
                  PRD 수정하기
                </button>
              </div>
            )}

            {/* Step Progress */}
            <div className="mb-8">
              {steps.map((step, idx) => {
                const stepComplete = isComplete ? true : idx < currentStepIdx;
                const isCurrent = !isComplete && !isFailed && idx === currentStepIdx;

                return (
                  <div key={step.key} className="flex items-start gap-4 mb-4">
                    <div className="flex flex-col items-center">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                          stepComplete
                            ? 'bg-green-600 text-white'
                            : isCurrent
                              ? 'bg-yellow-500 text-black animate-pulse'
                              : isFailed && idx === currentStepIdx
                                ? 'bg-red-500 text-white'
                                : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600'
                        }`}
                      >
                        {stepComplete ? '✓' : isFailed && idx === currentStepIdx ? '✗' : idx + 1}
                      </div>
                      {idx < steps.length - 1 && (
                        <div
                          className={`w-0.5 h-8 ${
                            stepComplete ? 'bg-green-600' : 'bg-gray-800'
                          }`}
                        />
                      )}
                    </div>
                    <div className="pt-1">
                      <p
                        className={`font-medium ${
                          stepComplete
                            ? 'text-green-400'
                            : isCurrent
                              ? 'text-yellow-400'
                              : isFailed && idx === currentStepIdx
                                ? 'text-red-400'
                                : 'text-gray-600'
                        }`}
                      >
                        {step.label}
                      </p>
                      {isCurrent && progress?.current_task && (
                        <p className="text-gray-500 text-sm mt-1">
                          {progress.current_task}
                        </p>
                      )}
                      {isCurrent && !progress?.current_task && (
                        <p className="text-gray-500 text-sm mt-1 animate-pulse">
                          진행 중...
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 로컬 문서 보기 (프로젝트 디렉토리의 현재 상태) */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-gray-600 dark:text-gray-400 text-sm">프로젝트 문서 (로컬, 빌드 중 갱신됨)</h3>
                {docsLoading && (
                  <span className="text-xs text-gray-500">로딩...</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setShowDoc('prd')}
                  disabled={!docs.prd}
                  className="px-3 py-2 rounded-lg text-xs font-medium border border-blue-400/50 text-blue-500 hover:bg-blue-400/10 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  📄 PRD.md {docs.prd && <span className="text-[10px] opacity-60">({docs.prd.length}자)</span>}
                </button>
                <button
                  onClick={() => setShowDoc('design')}
                  disabled={!docs.design}
                  className="px-3 py-2 rounded-lg text-xs font-medium border border-purple-400/50 text-purple-500 hover:bg-purple-400/10 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  🎨 DESIGN.md {docs.design && <span className="text-[10px] opacity-60">({docs.design.length}자)</span>}
                </button>
                <button
                  onClick={() => setShowDoc('claude')}
                  disabled={!docs.claude}
                  className="px-3 py-2 rounded-lg text-xs font-medium border border-gray-400/50 text-gray-500 hover:bg-gray-400/10 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  ⚙ CLAUDE.md
                </button>
              </div>
              {docs.project_path && (
                <p className="text-[10px] text-gray-500 mt-2 font-mono truncate">
                  {docs.project_path}
                </p>
              )}
            </div>

            {/* Logs */}
            <div>
              <h3 className="text-gray-600 dark:text-gray-400 text-sm mb-3">빌드 로그</h3>
              <BuildLog logs={logs.length > 0 ? logs : ['빌드 파이프라인 실행 중... (Hermes → Claude Code CLI)']} />
            </div>
          </>
        )}

        {tab === 'chat' && (
          <div>
            <div className="bg-gray-100 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-800 rounded-xl px-4 py-2.5 mb-4 text-xs text-gray-500">
              🔒 읽기 전용 — 과거 기획 대화 내역을 확인할 수 있습니다.
            </div>
            {chatLoading ? (
              <div className="flex justify-center py-20">
                <div className="w-6 h-6 border-2 border-gray-600 border-t-green-400 rounded-full animate-spin" />
              </div>
            ) : chatMessages.length === 0 ? (
              <div className="text-center text-gray-500 dark:text-gray-600 py-20">
                <p>저장된 대화가 없습니다.</p>
              </div>
            ) : (
              <div className="space-y-0">
                {chatMessages.map((msg, i) => (
                  <ChatMessage
                    key={i}
                    role={msg.role as 'user' | 'assistant'}
                    content={msg.content}
                    userLabel="owner"
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* 로컬 문서 모달 */}
      {showDoc && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
              <h2 className="text-gray-900 dark:text-white font-medium">
                {showDoc === 'prd' && '📄 PRD.md (프로젝트 디렉토리 현재 상태)'}
                {showDoc === 'design' && '🎨 DESIGN.md (프로젝트 디렉토리 현재 상태)'}
                {showDoc === 'claude' && '⚙ CLAUDE.md (빌드 에이전트 규칙)'}
              </h2>
              <button
                onClick={() => setShowDoc(null)}
                className="text-gray-400 hover:text-gray-900 dark:hover:text-white text-xl leading-none"
              >
                ✕
              </button>
            </div>
            <div className="overflow-y-auto px-6 py-4">
              <pre className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap font-sans leading-relaxed">
                {showDoc === 'prd' && (docs.prd || '(비어있음)')}
                {showDoc === 'design' && (docs.design || '(비어있음)')}
                {showDoc === 'claude' && (docs.claude || '(비어있음)')}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
