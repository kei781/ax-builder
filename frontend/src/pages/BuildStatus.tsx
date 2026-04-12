import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import BuildLog from '../components/BuildLog';
import { useWebSocket } from '../hooks/useWebSocket';
import client from '../api/client';

const steps = [
  { key: 'setup', label: '환경 준비' },
  { key: 'coding', label: '코드 생성' },
  { key: 'qa', label: 'QA 검증' },
  { key: 'deploy', label: '배포' },
];

type ProjectStatus = 'building' | 'qa' | 'deployed' | 'failed' | string;

export default function BuildStatus() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { connected, progress, lastEvent } = useWebSocket(id);
  const [logs, setLogs] = useState<string[]>([]);
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>('building');
  const [port, setPort] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startTime = useRef(Date.now());

  // 경과 시간 카운터
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // API 폴링 — WebSocket 안 될 때 대비
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

  // WebSocket 이벤트 반영
  useEffect(() => {
    if (lastEvent === 'build_complete') {
      setProjectStatus('deployed');
    } else if (lastEvent === 'build_failed') {
      setProjectStatus('failed');
    }
  }, [lastEvent]);

  // progress 로그 추가
  useEffect(() => {
    if (progress?.current_task) {
      setLogs((prev) => [...prev, progress.current_task]);
    }
  }, [progress]);

  const currentPhase = progress?.phase || (
    projectStatus === 'deployed' ? 'deploy' :
    projectStatus === 'qa' ? 'qa' :
    projectStatus === 'failed' ? 'deploy' : 'setup'
  );
  const currentStepIdx = steps.findIndex((s) => s.key === currentPhase);
  const isComplete = projectStatus === 'deployed';
  const isFailed = projectStatus === 'failed';

  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <a href="/" className="text-gray-500 hover:text-white">
          ← 대시보드
        </a>
        <h1 className="text-white font-medium">빌드 진행 상태</h1>
        <span
          className={`text-xs px-2 py-1 rounded-full ${
            connected
              ? 'bg-green-500/10 text-green-400'
              : 'bg-gray-800 text-gray-500'
          }`}
        >
          {connected ? '실시간 연결' : 'API 폴링'}
        </span>
        <span className="text-gray-500 text-xs ml-auto">
          경과: {Math.floor(elapsed / 60)}분 {elapsed % 60}초
        </span>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
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
                            : 'bg-gray-800 text-gray-600'
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

        {/* Logs */}
        <div>
          <h3 className="text-gray-400 text-sm mb-3">빌드 로그</h3>
          <BuildLog logs={logs.length > 0 ? logs : ['빌드 파이프라인 실행 중... (Hermes → Claude Code CLI)']} />
        </div>
      </main>
    </div>
  );
}
