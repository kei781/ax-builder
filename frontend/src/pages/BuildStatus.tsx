import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import BuildLog from '../components/BuildLog';
import client from '../api/client';

/**
 * Step 5 MVP build progress page. Subscribes to the unified agent_event
 * stream on /ws and shows phase progress + log lines. Full UI polish
 * (step-by-step stepper, docs viewer, etc.) lands in Step 6.
 */
interface AgentEvent {
  agent: string;
  project_id: string;
  event_type: string;
  phase?: string;
  progress_percent?: number;
  payload?: Record<string, unknown>;
}

export default function BuildStatus() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [phase, setPhase] = useState<string>('');
  const [percent, setPercent] = useState(0);
  const [projectState, setProjectState] = useState<string>('building');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Load build status from API (survives page refresh)
  useEffect(() => {
    if (!id) return;
    const load = async () => {
      try {
        // Project state
        const projRes = await client.get(`/projects/${id}`);
        setProjectState(projRes.data.state);

        // Build details from DB
        const buildRes = await client.get(`/projects/${id}/build/status`);
        const data = buildRes.data;
        if (data.build?.started_at) {
          startRef.current = new Date(data.build.started_at).getTime();
        }
        if (data.phases?.length) {
          const phaseLines: string[] = [];
          for (const p of data.phases as Array<{idx: number; name: string; status: string}>) {
            const icon = p.status === 'success' ? '✓' : p.status === 'running' ? '▸' : '○';
            phaseLines.push(`${icon} ${p.name} (${p.status})`);
            if (p.status === 'running') setPhase(p.name);
          }
          if (phaseLines.length) setLogs(phaseLines);
          // Estimate progress from completed phases
          const total = data.phases.length || 1;
          const done = (data.phases as Array<{status: string}>).filter(
            (p) => p.status === 'success',
          ).length;
          setPercent(Math.round((done / total) * 85) + 10);
        }
        if (data.state === 'deployed') {
          setProjectState('deployed');
          setPercent(100);
        }
        // Env stage — redirect to env input flow
        if (projRes.data.state === 'awaiting_env') {
          navigate(`/projects/${id}/env`, { replace: true });
          return;
        }
      } catch {
        /* ignore */
      }
    };
    load();
    const iv = setInterval(load, 10000); // poll every 10s as fallback
    return () => clearInterval(iv);
  }, [id]);

  // Real-time events via WS
  useEffect(() => {
    if (!id) return;
    const socket: Socket = io('/ws', { transports: ['polling', 'websocket'] });
    socket.on('connect', () => {
      setConnected(true);
      socket.emit('join', { projectId: id });
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on('agent_event', (event: AgentEvent) => {
      if (event.project_id !== id) return;
      if (event.agent !== 'building') return;

      if (event.phase) setPhase(event.phase);
      if (event.progress_percent !== undefined) setPercent(event.progress_percent);

      switch (event.event_type) {
        case 'progress': {
          const detail = (event.payload?.detail as string) || '';
          if (detail) setLogs((p) => [...p, `▸ ${detail}`]);
          break;
        }
        case 'phase_start': {
          const desc = (event.payload?.description as string) || event.phase || '';
          setLogs((p) => [...p, `\n== Phase: ${event.phase} ==`, desc]);
          if (event.phase === 'awaiting_env') {
            navigate(`/projects/${id}/env`, { replace: true });
          }
          break;
        }
        case 'phase_end': {
          const ok = event.payload?.ok === true;
          const dur = event.payload?.duration_s ?? '?';
          setLogs((p) => [...p, `${ok ? '✓' : '✗'} ${event.phase} (${dur}s)`]);
          break;
        }
        case 'log': {
          const line = (event.payload?.line as string) || '';
          if (line) setLogs((p) => [...p, line]);
          break;
        }
        case 'error': {
          const msg = (event.payload?.message as string) || 'unknown error';
          setError(msg);
          setLogs((p) => [...p, `⚠ ERROR: ${msg}`]);
          break;
        }
        case 'completion': {
          setProjectState('deployed');
          setPercent(100);
          setLogs((p) => [...p, '✓ 빌드 완료!']);
          break;
        }
        default:
          break;
      }
    });

    return () => { socket.disconnect(); };
  }, [id]);

  const isComplete = projectState === 'deployed';
  const isFailed = projectState === 'failed';
  const isBounced = phase === 'bounce_back';
  const isUpdateLine =
    projectState === 'updating' || projectState === 'update_qa';
  // 진행 중인 상태 — 중단 가능.
  const isRunning =
    projectState === 'building' ||
    projectState === 'qa' ||
    projectState === 'updating' ||
    projectState === 'update_qa';
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const handleCancel = async () => {
    if (!id || cancelling) return;
    if (!confirm(isUpdateLine ? '업데이트를 중단할까요?\n(이전 버전은 그대로 유지됩니다)' : '빌드를 중단할까요?')) {
      return;
    }
    setCancelling(true);
    try {
      const res = await client.post(`/projects/${id}/build/cancel`);
      setProjectState(res.data.state ?? 'failed');
      setLogs((p) => [...p, '⚠ 사용자 요청으로 중단됐습니다.']);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      alert(`중단 실패: ${e.response?.data?.message ?? '알 수 없는 오류'}`);
    } finally {
      setCancelling(false);
    }
  };

  const handleRetry = async () => {
    if (!id || retrying) return;
    setRetrying(true);
    try {
      // /build/retry — failed → plan_ready 복구 후 재빌드를 원자적으로.
      await client.post(`/projects/${id}/build/retry`);
      setProjectState('building');
      setPercent(0);
      setPhase('setup');
      setLogs(['↻ 재빌드 시작...']);
      startRef.current = Date.now();
      setError(null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      alert(
        `재빌드 실패: ${e.response?.data?.message ?? '알 수 없는 오류'}\n\n` +
          `기획 대화로 돌아가서 propose_handoff를 다시 호출해주세요.`,
      );
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <header className="border-b border-gray-200 dark:border-gray-800 px-6 py-4 flex items-center gap-4">
        <a href="/" className="text-gray-500 hover:text-gray-900 dark:hover:text-white">← 대시보드</a>
        <h1 className="text-gray-900 dark:text-white font-medium">
          {isUpdateLine ? '업데이트 진행 상태' : '빌드 진행 상태'}
        </h1>
        <span className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-green-500/10 text-green-400' : 'bg-gray-200 dark:bg-gray-800 text-gray-500'}`}>
          {connected ? '실시간' : '연결 중'}
        </span>
        <span className="text-gray-500 text-xs ml-auto">
          경과: {Math.floor(elapsed / 60)}분 {elapsed % 60}초
        </span>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* 업데이트 중 배너 — 기존 앱 접속 가능 */}
        {isUpdateLine && (
          <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-xl p-4 mb-6">
            <p className="text-cyan-700 dark:text-cyan-300 text-sm">
              ↺ 업데이트 진행 중 — 기존 앱은 계속 접속 가능합니다. 변경 적용이 실패해도 이전 버전이 유지됩니다.
            </p>
          </div>
        )}
        {/* Banner */}
        {isComplete && (
          <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4 mb-6 flex items-center justify-between">
            <p className="text-green-400 font-medium">
              {isUpdateLine ? '업데이트 완료!' : '빌드 완료!'}
            </p>
            <button onClick={() => navigate('/')} className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-xl text-sm">대시보드로</button>
          </div>
        )}
        {isFailed && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6 flex items-start justify-between gap-4">
            <div className="flex-1">
              <p className="text-red-400 font-medium">빌드 실패</p>
              {error && <p className="text-red-300/70 text-sm mt-1">{error}</p>}
              <p className="text-red-300/60 text-xs mt-2">
                프로세스가 중단됐거나 실행 환경 문제였다면 "다시 빌드"로 재시도할 수 있어요.
                기획 자체에 수정이 필요하면 "기획 대화로"를 선택하세요.
              </p>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              <button
                onClick={handleRetry}
                disabled={retrying}
                className="bg-red-500 hover:bg-red-400 disabled:bg-gray-400 text-white px-4 py-2 rounded-xl text-sm font-medium"
              >
                {retrying ? '재시작 중...' : '↻ 다시 빌드'}
              </button>
              <button
                onClick={() => navigate(`/projects/${id}/chat`)}
                className="bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-4 py-2 rounded-xl text-sm"
              >
                기획 대화로
              </button>
            </div>
          </div>
        )}
        {isBounced && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 mb-6 flex items-center justify-between">
            <div>
              <p className="text-yellow-400 font-medium">기획 보강 필요</p>
              <p className="text-yellow-300/70 text-sm mt-1">문서가 빌드에 충분하지 않아 기획 대화로 돌아갑니다.</p>
            </div>
            <button onClick={() => navigate(`/projects/${id}/chat`)} className="bg-yellow-500 hover:bg-yellow-400 text-white px-4 py-2 rounded-xl text-sm">기획 대화로</button>
          </div>
        )}

        {/* Progress + Cancel */}
        {!isComplete && !isFailed && !isBounced && (
          <div className="mb-6">
            <div className="flex justify-between items-center text-xs text-gray-500 mb-1">
              <span>{phase || 'setup'}</span>
              <div className="flex items-center gap-3">
                <span>{percent}%</span>
                {isRunning && (
                  <button
                    onClick={handleCancel}
                    disabled={cancelling}
                    className="text-xs bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 px-3 py-1 rounded-lg disabled:opacity-50"
                  >
                    {cancelling
                      ? '중단 중...'
                      : isUpdateLine
                        ? '↺ 업데이트 중단'
                        : '■ 빌드 중단'}
                  </button>
                )}
              </div>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all duration-500 ${
                  isUpdateLine ? 'bg-cyan-500' : 'bg-green-500'
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}

        {/* Logs */}
        <div>
          <h3 className="text-gray-600 dark:text-gray-400 text-sm mb-3">빌드 로그</h3>
          <BuildLog logs={logs.length > 0 ? logs : ['빌드 대기 중...']} />
        </div>
      </main>
    </div>
  );
}
