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
  | 'planning_update'
  | 'update_ready'
  | 'updating'
  | 'update_qa';

interface ProjectInfo {
  id: string;
  title: string;
  state: ProjectState;
  current_session_id: string | null;
  port: number | null;
  failure_reason?: string[] | null;
  /**
   * 빌드가 반송(bounced)돼서 planning/plan_ready로 되돌아왔을 때만
   * 채워진다. 유저가 직전 실패 이유를 즉시 볼 수 있도록 배너로 노출.
   */
  last_bounce?: {
    build_id: string;
    finished_at: string | null;
    gap_list: string[];
  } | null;
}

const STATE_LABELS: Record<ProjectState, string> = {
  draft: '새 프로젝트',
  planning: '기획 중',
  plan_ready: '빌드 준비 완료',
  building: '빌드 중',
  qa: 'QA 검증 중',
  deployed: '배포됨',
  failed: '실패',
  // ADR 0008 업데이트 라인
  planning_update: '수정 기획 중',
  update_ready: '업데이트 준비 완료',
  updating: '업데이트 중',
  update_qa: '회귀 검증 중',
};

const STATE_COLORS: Record<ProjectState, string> = {
  draft: 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  planning: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  plan_ready: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  building: 'bg-blue-600/10 text-blue-700 dark:text-blue-300',
  qa: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
  deployed: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/10 text-red-500 dark:text-red-400',
  // 업데이트 라인 색 체계 (DESIGN §5.1)
  planning_update: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  update_ready: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  updating: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  update_qa: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
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
  // handoff 배너 — AI 텍스트 대신 "도구 결과를 직접" 표시해 환각 차단.
  // kind='success'  = accepted → plan_ready/update_ready 전이됨
  // kind='rejected' = accepted=false 또는 ok=false → 거부 이유 노출
  // kind='warning'  = 기타 주의 (ex: watchdog "AI가 도구 호출 안 함")
  const [handoffBanner, setHandoffBanner] = useState<{
    kind: 'success' | 'rejected' | 'warning';
    detail: string;
    detail_extra?: string;
  } | null>(null);
  const [building, setBuilding] = useState(false);
  const [readiness, setReadiness] = useState<{
    completeness: Record<string, number>;
    score: number;
    can_build: boolean;
    is_sufficient: boolean;
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
            // Restore readiness from handoff (survives page refresh)
            if (res.data.readiness) {
              setReadiness(res.data.readiness);
            }
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
    const socket = io('/ws', { transports: ['polling', 'websocket'] });
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
            // is_sufficient: min >= 0.85 (충분 조건). p에 명시가 없으면 로컬 계산.
            const vals = Object.values(p.completeness);
            const minScore = vals.length ? Math.min(...vals) : 0;
            const canBuild = p.can_build ?? minScore >= 0.6;
            const isSufficient = p.is_sufficient ?? minScore >= 0.85;
            setReadiness({
              completeness: p.completeness,
              score: p.score ?? 0,
              can_build: canBuild,
              is_sufficient: isSufficient,
              summary: p.summary ?? '',
              label:
                p.label ||
                (isSufficient
                  ? '충분 조건 충족'
                  : canBuild
                    ? '최소 조건 충족 (보강 권장)'
                    : '보강 필요'),
            });
          }
          // plan_ready / update_ready — 성공 전이.
          if (
            event.phase === 'plan_ready' ||
            event.phase === 'update_ready' ||
            event.phase === 'build_requested'
          ) {
            if (
              (event.phase === 'plan_ready' || event.phase === 'update_ready') &&
              p?.detail
            ) {
              setHandoffBanner({ kind: 'success', detail: p.detail });
            }
            void fetchProject();
          }
          // hallucination_detected — AI가 "도구 호출합니다" 텍스트 + 실제 tool_call
          // 0회. 유저가 "왜 안 되지?" 혼란스럽지 않게 명시적 배너.
          if (event.phase === 'hallucination_detected') {
            const pr = p as { detail?: string };
            setHandoffBanner({
              kind: 'warning',
              detail: pr.detail ?? 'AI가 도구 호출을 텍스트로만 언급했고 실제 호출은 없었어요.',
            });
          }
          // handoff_rejected — accepted=false. AI 텍스트 대신 이 배너가 진실.
          if (event.phase === 'handoff_rejected') {
            const pr = p as {
              detail?: string;
              min_completeness?: number;
              is_sufficient?: boolean;
              has_unresolved?: boolean;
            };
            const extras: string[] = [];
            if (typeof pr.min_completeness === 'number') {
              extras.push(`최저 완성도 ${(pr.min_completeness * 100).toFixed(0)}%`);
            }
            if (pr.has_unresolved) {
              extras.push('남은 질문 있음');
            }
            setHandoffBanner({
              kind: 'rejected',
              detail: pr.detail ?? '핸드오프가 거부됐습니다.',
              detail_extra: extras.length ? extras.join(' · ') : undefined,
            });
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

          // propose_handoff 결과는 server-side handleAgentEvent가 progress(phase=
          // handoff_rejected/plan_ready/update_ready) 이벤트로 전용 emit하므로
          // 여기서 중복 배너 설정하지 않는다. (AI 텍스트 의존 제거 — 회고 §5)
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
    const s = project?.state;
    if (s === 'building' || s === 'qa' || s === 'updating' || s === 'update_qa') {
      setStatus(
        s === 'updating' || s === 'update_qa'
          ? '업데이트 중에는 대화할 수 없습니다.'
          : '빌드 중에는 대화할 수 없습니다.',
      );
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

    // can_build이지만 아직 plan_ready/update_ready가 아니면 = AI가 propose_handoff 안 함.
    // 자동으로 AI에게 핸드오프 요청 메시지를 보냄 (유저가 직접 프롬프트 안 쳐도 됨)
    const ready = project?.state === 'plan_ready' || project?.state === 'update_ready';
    if (!ready && readiness?.can_build) {
      const autoMsg =
        '기획이 충분히 정리됐습니다. propose_handoff 도구를 호출해서 ' +
        '다음 단계로 이관을 제안해주세요. ' +
        '텍스트로만 "완료"라고 답하지 말고 반드시 도구를 호출하세요.';
      setMessages((prev) => [...prev, { role: 'user', content: autoMsg }]);
      setLoading(true);
      setStatus('핸드오프 요청 중...');
      try {
        await client.post(`/projects/${id}/chat/messages`, { content: autoMsg });
        // Watchdog: 15s 안에 *_ready 전이가 안 보이면 AI가 도구 호출 안 한 것.
        // ARCHITECTURE.md §6.6 참조.
        const checkAt = Date.now();
        setTimeout(async () => {
          try {
            const r = await client.get(`/projects/${id}`);
            if (r.data.state !== 'plan_ready' && r.data.state !== 'update_ready') {
              setHandoffBanner({
                kind: 'warning',
                detail:
                  'AI가 도구를 호출하지 않은 것 같아요. "AI에게 핸드오프 요청"을 한 번 더 눌러주세요.',
              });
              setStatus('핸드오프 재시도 필요');
            }
          } catch {
            /* ignore — user may have navigated away */
          }
          // keep stale-check hint scoped to this click
          void checkAt;
        }, 15_000);
      } catch (err: unknown) {
        const e = err as { response?: { data?: { message?: string } } };
        setStatus(`⚠ ${e.response?.data?.message ?? '요청 실패'}`);
        setLoading(false);
      }
      return;
    }

    setBuilding(true);
    try {
      await client.post(`/projects/${id}/build`);
      setTimeout(() => {
        void fetchProject();
      }, 300);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      // 프로미넌트한 alert — status bar에 묻히지 않게
      alert(`빌드 시작 실패: ${e.response?.data?.message ?? '알 수 없는 오류'}`);
      setStatus(`⚠ ${e.response?.data?.message ?? '빌드 시작 실패'}`);
    } finally {
      setBuilding(false);
    }
  };

  const canBuild = project?.state === 'plan_ready' || project?.state === 'update_ready';
  const isUpdateLine =
    project?.state === 'planning_update' ||
    project?.state === 'update_ready' ||
    project?.state === 'updating' ||
    project?.state === 'update_qa';
  const canEdit = myRole === 'owner' || myRole === 'editor';
  const state = project?.state ?? 'draft';

  // 사이드바 색 체계 (ADR-independent — UX 일관성):
  //   is_sufficient (min>=0.85): 초록 — "진짜 빌드 가능" 신호
  //   can_build (min>=0.6)     : 노랑 — "최소 조건 충족, propose_handoff 거부 가능"
  //   그 외                     : 빨강 — "보강 필요"
  const scoreColor = readiness?.is_sufficient
    ? 'text-green-500 dark:text-green-400'
    : readiness?.can_build
      ? 'text-yellow-500 dark:text-yellow-400'
      : 'text-red-500 dark:text-red-400';
  const scoreBarColor = readiness?.is_sufficient
    ? 'bg-green-500'
    : readiness?.can_build
      ? 'bg-yellow-500'
      : 'bg-red-500';

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

      {/* Failure banner */}
      {state === 'failed' && project?.failure_reason && project.failure_reason.length > 0 && (
        <div className="px-6 py-3 bg-red-500/10 border-b border-red-500/30">
          <p className="text-sm text-red-700 dark:text-red-400 font-medium mb-1">
            ⚠ 이전 빌드가 실패했습니다. 아래 내용을 참고하여 기획을 보강하거나 재시도해주세요.
          </p>
          <ul className="text-xs text-red-600 dark:text-red-300 ml-4 list-disc space-y-0.5">
            {project.failure_reason.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 업데이트 사이클 안내 — planning_update / update_ready에서 노출.
          이전 대화가 안 보이는 이유를 유저가 오해하지 않게. 대화가 몇 개
          없을 때만 표시 (사이클 중간부턴 이미 맥락 알고 있음). */}
      {(state === 'planning_update' || state === 'update_ready') &&
        messages.length <= 2 && (
          <div className="px-6 py-3 bg-indigo-500/10 border-b border-indigo-500/30">
            <p className="text-sm text-indigo-700 dark:text-indigo-300 font-medium mb-1">
              ↻ 업데이트 사이클을 새로 시작합니다
            </p>
            <p className="text-xs text-indigo-700 dark:text-indigo-400">
              이전 기획 대화는 PRD·DESIGN 문서에 이미 반영된 상태입니다. 이번 사이클은 **새로 추가·수정하고 싶은 기능**만 논의해요. AI가 현재 문서를 읽고 맞춰드립니다.
            </p>
          </div>
        )}

      {/* Bounce-back banner — build/update가 반송되어 planning/plan_ready/planning_update로 돌아왔을 때 */}
      {(state === 'planning' ||
        state === 'plan_ready' ||
        state === 'planning_update' ||
        state === 'update_ready') &&
        project?.last_bounce &&
        project.last_bounce.gap_list.length > 0 && (
          <div className="px-6 py-3 bg-yellow-500/10 border-b border-yellow-500/30">
            <p className="text-sm text-yellow-700 dark:text-yellow-400 font-medium mb-1">
              ↩ 이전 {isUpdateLine ? '업데이트' : '빌드'}가 아래 이유로 돌아왔습니다.
              {isUpdateLine
                ? ' 이전 버전은 계속 운영 중입니다. 확인 후 다시 시도해주세요.'
                : ' 확인하고 보강한 뒤 다시 빌드를 시작해주세요.'}
            </p>
            <ul className="text-xs text-yellow-700 dark:text-yellow-300 ml-4 list-disc space-y-0.5">
              {project.last_bounce.gap_list.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </div>
        )}

      {/* Handoff banner — 도구 결과를 직접 표시. AI 텍스트에 의존하지 않는다. */}
      {handoffBanner && handoffBanner.kind === 'success' && (
        <div className="px-6 py-3 bg-green-500/10 border-b border-green-500/30 flex items-center justify-between">
          <span className="text-sm text-green-700 dark:text-green-400">
            🎉 {handoffBanner.detail}
          </span>
          {canBuild && (
            <button
              onClick={handleBuild}
              disabled={building}
              className="bg-green-600 hover:bg-green-500 disabled:bg-gray-400 text-white text-sm px-4 py-1.5 rounded-lg font-medium"
            >
              {building
                ? '시작 중...'
                : isUpdateLine
                  ? '↺ 업데이트 시작'
                  : '🚀 빌드 시작'}
            </button>
          )}
        </div>
      )}
      {handoffBanner && handoffBanner.kind === 'rejected' && (
        <div className="px-6 py-3 bg-orange-500/10 border-b border-orange-500/30">
          <p className="text-sm text-orange-700 dark:text-orange-300 font-medium mb-1">
            ⚠ 핸드오프 거부 — {handoffBanner.detail}
          </p>
          {handoffBanner.detail_extra && (
            <p className="text-xs text-orange-700 dark:text-orange-400">
              {handoffBanner.detail_extra}
            </p>
          )}
          <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">
            AI의 텍스트 설명과 무관하게 실제 도구 판정입니다. 대화로 기획을 보강한 뒤 다시 시도해주세요.
          </p>
        </div>
      )}
      {handoffBanner && handoffBanner.kind === 'warning' && (
        <div className="px-6 py-3 bg-yellow-500/10 border-b border-yellow-500/30">
          <p className="text-sm text-yellow-700 dark:text-yellow-300">
            ⚠ {handoffBanner.detail}
          </p>
        </div>
      )}

      {/* Build / Update redirect prompt */}
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
      {(state === 'updating' || state === 'update_qa') && (
        <div className="px-6 py-3 bg-cyan-500/10 border-b border-cyan-500/30 flex items-center justify-between">
          <span className="text-sm text-cyan-700 dark:text-cyan-300">
            업데이트가 진행 중입니다. 기존 앱은 계속 접속 가능합니다.
          </span>
          <button
            onClick={() => navigate(`/projects/${id}/build`)}
            className="bg-cyan-500 hover:bg-cyan-400 text-white text-sm px-4 py-1.5 rounded-lg font-medium"
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
            {isUpdateLine ? (
              <>
                <p className="text-lg mb-2 text-gray-900 dark:text-white">
                  어떤 기능을 추가하거나 수정하고 싶으세요?
                </p>
                <p className="text-sm">
                  현재 앱은 이미 운영 중이에요. 새 기능 요청이나 개선 아이디어를 알려주시면 AI가 검토 후 문서에 반영합니다.
                </p>
              </>
            ) : (
              <>
                <p className="text-lg mb-2 text-gray-900 dark:text-white">
                  어떤 문제를 해결하고 싶으신가요?
                </p>
                <p className="text-sm">AI가 아이디어를 제품으로 구체화해드립니다.</p>
              </>
            )}
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatMessage key={i} role={msg.role} content={msg.content} userLabel="owner" />
        ))}
        {pendingAssistant && (
          <ChatMessage role="assistant" content={pendingAssistant} userLabel="owner" />
        )}
        {/* AI 진행 상태 — pendingAssistant 토큰이 아직 안 왔어도 loading이면 표시.
            유저가 "얘가 뭐 하고 있나?" 불확실하지 않게. status에는 tool call 등
            상세 정보가 실시간으로 들어옴. */}
        {loading && !pendingAssistant && (
          <div className="flex items-start gap-3 my-4 ml-1">
            <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-800 flex items-center justify-center text-xs text-gray-500 shrink-0">
              AI
            </div>
            <div className="bg-gray-100 dark:bg-gray-900 rounded-2xl px-4 py-3 flex items-center gap-2">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-gray-400 dark:bg-gray-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 bg-gray-400 dark:bg-gray-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 bg-gray-400 dark:bg-gray-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {status || (isUpdateLine ? '수정 사항 검토 중...' : '생각 중...')}
              </span>
            </div>
          </div>
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
                  ? state === 'update_ready'
                    ? '업데이트 준비가 완료됐습니다. 추가 수정 요청이 있으면 입력하세요.'
                    : '빌드 준비가 완료됐습니다. 추가 요청이 있으면 입력하세요.'
                  : isUpdateLine
                    ? '수정 내용을 입력하세요...'
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
              disabled={
                loading ||
                state === 'building' ||
                state === 'qa' ||
                state === 'updating' ||
                state === 'update_qa'
              }
            />
            <button
              onClick={handleSend}
              disabled={
                !input.trim() ||
                loading ||
                state === 'building' ||
                state === 'qa' ||
                state === 'updating' ||
                state === 'update_qa'
              }
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
              className={`${scoreBarColor} h-3 rounded-full transition-all duration-500`}
              style={{ width: `${((readiness?.score ?? 0) / 1000) * 100}%` }}
            />
          </div>
          <p className={`text-sm ${scoreColor}`}>{readiness?.label ?? '대화를 시작하세요'}</p>
          {readiness?.can_build && !readiness?.is_sufficient && (
            <p className="text-yellow-600 dark:text-yellow-400 text-xs mt-1">
              ⚠ 최소 조건만 충족 — propose_handoff가 "보강 권장"으로 거부될 수 있어요.
            </p>
          )}
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
                  ? isUpdateLine
                    ? 'bg-teal-600 hover:bg-teal-500 text-white'
                    : 'bg-green-600 hover:bg-green-500 text-white'
                  : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
              }`}
            >
              {canBuild
                ? isUpdateLine
                  ? '↺ 업데이트 시작'
                  : '🚀 제작 시작'
                : readiness?.can_build
                  ? loading
                    ? '핸드오프 요청 중...'
                    : isUpdateLine
                      ? '📋 AI에게 업데이트 이관 요청'
                      : '📋 AI에게 핸드오프 요청'
                  : `스코어 600점 이상 시 제작 가능`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
