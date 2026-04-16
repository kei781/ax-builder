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

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <header className="border-b border-gray-200 dark:border-gray-800 px-6 py-4 flex items-center gap-4">
        <a href="/" className="text-gray-500 hover:text-gray-900 dark:hover:text-white">← 대시보드</a>
        <h1 className="text-gray-900 dark:text-white font-medium">빌드 진행 상태</h1>
        <span className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-green-500/10 text-green-400' : 'bg-gray-200 dark:bg-gray-800 text-gray-500'}`}>
          {connected ? '실시간' : '연결 중'}
        </span>
        <span className="text-gray-500 text-xs ml-auto">
          경과: {Math.floor(elapsed / 60)}분 {elapsed % 60}초
        </span>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* Banner */}
        {isComplete && (
          <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4 mb-6 flex items-center justify-between">
            <p className="text-green-400 font-medium">빌드 완료!</p>
            <button onClick={() => navigate('/')} className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-xl text-sm">대시보드로</button>
          </div>
        )}
        {isFailed && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6">
            <p className="text-red-400 font-medium">빌드 실패</p>
            {error && <p className="text-red-300/70 text-sm mt-1">{error}</p>}
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

        {/* Progress */}
        {!isComplete && !isFailed && !isBounced && (
          <div className="mb-6">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>{phase || 'setup'}</span>
              <span>{percent}%</span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2">
              <div
                className="bg-green-500 h-2 rounded-full transition-all duration-500"
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
