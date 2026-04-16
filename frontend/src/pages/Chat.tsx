import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import ChatMessage from '../components/ChatMessage';
import client from '../api/client';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface AgentEvent {
  agent: 'planning' | 'building';
  project_id: string;
  session_id?: string;
  event_type:
    | 'progress'
    | 'log'
    | 'error'
    | 'user_prompt'
    | 'phase_start'
    | 'phase_end'
    | 'token'
    | 'tool_call'
    | 'tool_result'
    | 'completion';
  phase?: string;
  progress_percent?: number;
  payload?: unknown;
  at?: number;
}

type ProjectState =
  | 'draft'
  | 'planning'
  | 'plan_ready'
  | 'building'
  | 'qa'
  | 'deployed'
  | 'failed'
  | 'modifying';

interface ProjectInfo {
  id: string;
  title: string;
  state: ProjectState;
  current_session_id: string | null;
  port: number | null;
}

const STATE_LABELS: Record<ProjectState, string> = {
  draft: '새 프로젝트',
  planning: '기획 중',
  plan_ready: '빌드 준비 완료',
  building: '빌드 중',
  qa: 'QA 검증 중',
  deployed: '배포됨',
  failed: '실패',
  modifying: '수정 중',
};

const STATE_COLORS: Record<ProjectState, string> = {
  draft: 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  planning: 'bg-blue-500/10 text-blue-500 dark:text-blue-400',
  plan_ready: 'bg-green-500/10 text-green-600 dark:text-green-400',
  building: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  qa: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  deployed: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/10 text-red-500 dark:text-red-400',
  modifying: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
};

export default function Chat() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingAssistant, setPendingAssistant] = useState<string>('');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [myRole, setMyRole] = useState<'owner' | 'editor' | 'viewer'>('viewer');
  const [handoffBanner, setHandoffBanner] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [readiness, setReadiness] = useState<{
    completeness: Record<string, number>;
    score: number;
    can_build: boolean;
    summary: string;
    label: string;
  } | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchProject = useCallback(async () => {
    if (!id) return;
    try {
      const res = await client.get(`/projects/${id}`);
      setProject(res.data);
    } catch {
      /* ignore — controller returns 404 if deleted */
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    (async () => {
      await Promise.all([
        fetchProject(),
        client
          .get(`/projects/${id}/chat/history`)
          .then((res) => {
            const loaded = (res.data.messages || []).map(
              (m: { role: string; content: string }) => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
              }),
            );
            setMessages(loaded);
          })
          .catch(() => {
            /* empty history */
          }),
        // Determine my role on this project
        client
          .get('/projects')
          .then((res) => {
            const mine = (res.data as Array<{ id: string; myRole: string }>)
              .find((p) => p.id === id);
            if (mine) setMyRole(mine.myRole as typeof myRole);
          })
          .catch(() => {
            /* default viewer */
          }),
      ]);
      setHistoryLoading(false);
    })();
  }, [id, fetchProject]);

  useEffect(() => {
    if (!id) return;
    const socket = io('/ws', { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('join', { projectId: id });
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on('agent_event', (event: AgentEvent) => {
      if (event.project_id !== id) return;
      handleAgentEvent(event);
    });

    return () => {
      socket.disconnect();
    };
  }, [id]);

  const handleAgentEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.event_type) {
        case 'progress': {
          const p = event.payload as {
            detail?: string;
            is_sufficient?: boolean;
            completeness?: Record<string, number>;
            score?: number;
            can_build?: boolean;
            summary?: string;
            label?: string;
          } | undefined;
          if (p?.detail) setStatus(p.detail);

          // readiness_update from evaluate_readiness tool
          if (event.phase === 'readiness_update' && p?.completeness) {
            setReadiness({
              completeness: p.completeness,
              score: p.score ?? 0,
              can_build: p.can_build ?? false,
              summary: p.summary ?? '',
              label: p.label ?? '',
            });
          }
          // plan_ready transition
          if (event.phase === 'plan_ready' || event.phase === 'build_requested') {
            if (event.phase === 'plan_ready' && p?.detail) {
              setHandoffBanner(p.detail);
            }
            void fetchProject();
          }
          break;
        }
        case 'token': {
          const p = event.payload as { delta?: string } | undefined;
          if (p?.delta) setPendingAssistant((prev) => prev + p.delta);
          break;
        }
        case 'tool_call': {
          const p = event.payload as { name?: string } | undefined;
          setStatus(`🔧 ${p?.name ?? 'tool'} 호출 중...`);
          break;
        }
        case 'tool_result': {
          const p = event.payload as {
            name?: string;
            result?: {
              ok?: boolean;
              path?: string;
              error?: string;
              accepted?: boolean;
              min_completeness?: number;
              reason?: string;
            };
          } | undefined;
          const ok = p?.result?.ok !== false;
          const where = p?.result?.path ? ` (${p.result.path})` : '';
          const err = p?.result?.error ? ` — ${p.result.error}` : '';
          setStatus(`${ok ? '✓' : '✗'} ${p?.name ?? 'tool'}${where}${err}`);

          if (p?.name === 'propose_handoff' && ok) {
            const accepted = p.result?.accepted === true;
            if (!accepted && p.result?.reason) {
              setHandoffBanner(`핸드오프 보류: ${p.result.reason}`);
            }
          }
          break;
        }
        case 'completion': {
          const p = event.payload as { role?: string; content?: string } | undefined;
          setPendingAssistant('');
          setStatus('');
          setLoading(false);
          if (p?.role === 'assistant' && p?.content) {
            setMessages((prev) => [...prev, { role: 'assistant', content: p.content! }]);
          }
          // Post-turn, state may have changed (e.g. first message → planning).
          void fetchProject();
          break;
        }
        case 'error': {
          const p = event.payload as { message?: string } | undefined;
          setStatus(`⚠ ${p?.message ?? 'error'}`);
          setPendingAssistant('');
          setLoading(false);
          break;
        }
        case 'log':
          break;
        default:
          break;
      }
    },
    [fetchProject],
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingAssistant]);

  const handleSend = async () => {
    if (!input.trim() || loading || !id) return;
    if (project?.state === 'building' || project?.state === 'qa') {
      setStatus('빌드 중에는 대화할 수 없습니다.');
      return;
    }
    const content = input;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content }]);
    setLoading(true);
    setStatus('thinking...');
    try {
      await client.post(`/projects/${id}/chat/messages`, { content });
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      setStatus(`⚠ ${e.response?.data?.message ?? '전송 실패'}`);
      setLoading(false);
    }
  };

  const handleBuild = async () => {
    if (!id || building) return;
    setBuilding(true);
    try {
      await client.post(`/projects/${id}/build`);
      // Server transitions state; socket will push a `build_requested` event.
      // UI awaits the next state fetch to flip views.
      setTimeout(() => {
        void fetchProject();
      }, 300);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      setStatus(`⚠ ${e.response?.data?.message ?? '빌드 시작 실패'}`);
    } finally {
      setBuilding(false);
    }
  };

  const canBuild = project?.state === 'plan_ready';
  const canEdit = myRole === 'owner' || myRole === 'editor';
  const state = project?.state ?? 'draft';

  const scoreColor = (readiness?.score ?? 0) >= 600
    ? 'text-green-400'
    : (readiness?.score ?? 0) >= 400
      ? 'text-yellow-400'
      : 'text-red-400';

  const CATEGORY_LABELS: Record<string, string> = {
    problem_definition: '문제 정의',
    feature_list: '기능 목록',
    user_flow: '사용 흐름',
    feasibility: '기술 실현성',
    user_experience: '사용자 경험',
  };

  return (
    <div className="h-screen bg-gray-50 dark:bg-gray-950 flex overflow-hidden">
      {/* Chat column */}
      <div className="flex-1 flex flex-col min-h-0">
      <header className="shrink-0 border-b border-gray-200 dark:border-gray-800 px-6 py-4 flex items-center gap-4">
        <a href="/" className="text-gray-500 hover:text-gray-900 dark:hover:text-white">
          ← 대시보드
        </a>
        <h1 className="text-gray-900 dark:text-white font-medium">
          {project?.title ?? '기획 대화'}
        </h1>
        <span className={`text-xs px-2 py-1 rounded-full ${STATE_COLORS[state]}`}>
          {STATE_LABELS[state]}
        </span>
        <span
          className={`text-xs px-2 py-1 rounded-full ${
            connected
              ? 'bg-green-500/10 text-green-400'
              : 'bg-gray-200 dark:bg-gray-800 text-gray-500'
          }`}
        >
          {connected ? '실시간' : '연결 중'}
        </span>
        {status && <span className="text-xs text-gray-500 ml-auto">{status}</span>}
      </header>

      {/* Handoff banner */}
      {handoffBanner && (
        <div className="px-6 py-3 bg-green-500/10 border-b border-green-500/30 flex items-center justify-between">
          <span className="text-sm text-green-700 dark:text-green-400">
            🎉 {handoffBanner}
          </span>
          {canBuild && (
            <button
              onClick={handleBuild}
              disabled={building}
              className="bg-green-600 hover:bg-green-500 disabled:bg-gray-400 text-white text-sm px-4 py-1.5 rounded-lg font-medium"
            >
              {building ? '시작 중...' : '🚀 빌드 시작'}
            </button>
          )}
        </div>
      )}

      {/* Build redirect prompt */}
      {(state === 'building' || state === 'qa') && (
        <div className="px-6 py-3 bg-yellow-500/10 border-b border-yellow-500/30 flex items-center justify-between">
          <span className="text-sm text-yellow-700 dark:text-yellow-400">
            빌드가 진행 중입니다.
          </span>
          <button
            onClick={() => navigate(`/projects/${id}/build`)}
            className="bg-yellow-500 hover:bg-yellow-400 text-white text-sm px-4 py-1.5 rounded-lg font-medium"
          >
            진행 상태 보기 →
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 max-w-3xl mx-auto w-full">
        {historyLoading && (
          <div className="flex justify-center items-center mt-20">
            <div className="w-6 h-6 border-2 border-gray-600 border-t-green-400 rounded-full animate-spin" />
            <span className="ml-3 text-gray-500 text-sm">대화 불러오는 중...</span>
          </div>
        )}
        {!historyLoading && messages.length === 0 && !pendingAssistant && (
          <div className="text-center text-gray-500 dark:text-gray-600 mt-20">
            <p className="text-lg mb-2 text-gray-900 dark:text-white">
              어떤 문제를 해결하고 싶으신가요?
            </p>
            <p className="text-sm">AI가 아이디어를 제품으로 구체화해드립니다.</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatMessage key={i} role={msg.role} content={msg.content} userLabel="owner" />
        ))}
        {pendingAssistant && (
          <ChatMessage role="assistant" content={pendingAssistant} userLabel="owner" />
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {canEdit ? (
        <div className="border-t border-gray-200 dark:border-gray-800 px-6 py-4 max-w-3xl mx-auto w-full">
          <div className="flex gap-3 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                canBuild
                  ? '빌드 준비가 완료됐습니다. 추가 요청이 있으면 입력하세요.'
                  : '아이디어를 입력하세요...'
              }
              className="flex-1 bg-white dark:bg-gray-900 text-gray-900 dark:text-white rounded-xl px-4 py-3 text-sm border border-gray-200 dark:border-gray-700 focus:border-green-500 focus:outline-none resize-none leading-5"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              disabled={loading || state === 'building' || state === 'qa'}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading || state === 'building' || state === 'qa'}
              className="bg-green-600 hover:bg-green-500 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white px-6 py-3 rounded-xl text-sm font-medium transition-colors shrink-0"
            >
              전송
            </button>
          </div>
          <p className="text-gray-500 dark:text-gray-600 text-xs mt-1">Shift+Enter로 줄바꿈</p>
        </div>
      ) : (
        <div className="border-t border-gray-200 dark:border-gray-800 px-6 py-4 max-w-3xl mx-auto w-full text-center">
          <p className="text-gray-500 text-sm">읽기 전용 — 대화 내역만 확인할 수 있습니다.</p>
        </div>
      )}
      </div>{/* end chat column */}

      {/* Score sidebar */}
      <div className="w-80 border-l border-gray-200 dark:border-gray-800 p-6 flex flex-col overflow-y-auto shrink-0">
        {/* Score */}
        <div className="mb-6">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-gray-500 dark:text-gray-400 text-sm">스코어</span>
            <span className={`text-2xl font-bold ${scoreColor}`}>
              {readiness?.score ?? 0}
              <span className="text-gray-500 text-sm font-normal">/1000</span>
            </span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-3 mb-2">
            <div
              className="bg-green-500 h-3 rounded-full transition-all duration-500"
              style={{ width: `${((readiness?.score ?? 0) / 1000) * 100}%` }}
            />
          </div>
          <p className={`text-sm ${scoreColor}`}>{readiness?.label ?? '대화를 시작하세요'}</p>
          {readiness?.summary && (
            <p className="text-gray-500 text-xs mt-1">{readiness.summary}</p>
          )}
        </div>

        {/* Category bars */}
        <div className="mb-6">
          <h3 className="text-gray-500 dark:text-gray-400 text-xs uppercase mb-3">항목별 점수</h3>
          {Object.entries(readiness?.completeness ?? {}).map(([key, val]) => (
            <div key={key} className="mb-2">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-gray-600 dark:text-gray-400">
                  {CATEGORY_LABELS[key] ?? key}
                </span>
                <span className="text-gray-500">{Math.round((val as number) * 100)}%</span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-1.5">
                <div
                  className={`h-1.5 rounded-full transition-all duration-500 ${
                    (val as number) >= 0.6 ? 'bg-green-500' : (val as number) >= 0.3 ? 'bg-yellow-500' : 'bg-red-500'
                  }`}
                  style={{ width: `${(val as number) * 100}%` }}
                />
              </div>
            </div>
          ))}
          {!readiness && (
            <p className="text-gray-500 dark:text-gray-600 text-xs">
              대화가 진행되면 AI가 자동으로 평가합니다.
            </p>
          )}
        </div>

        {/* Build button */}
        {canEdit && (
          <div className="mt-auto">
            <button
              onClick={handleBuild}
              disabled={!canBuild && !(readiness?.can_build)}
              className={`w-full py-3 rounded-xl text-sm font-medium transition-colors ${
                canBuild || readiness?.can_build
                  ? 'bg-green-600 hover:bg-green-500 text-white'
                  : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
              }`}
            >
              {canBuild
                ? '🚀 제작 시작'
                : readiness?.can_build
                  ? '기획 완성 → 제작 시작 가능'
                  : `스코어 600점 이상 시 제작 가능`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
