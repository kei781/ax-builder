import { useState } from 'react';
import { useParams } from 'react-router-dom';
import BuildLog from '../components/BuildLog';
import { useWebSocket } from '../hooks/useWebSocket';

const steps = [
  { key: 'setup', label: '환경 준비' },
  { key: 'coding', label: '코드 생성' },
  { key: 'qa', label: 'QA 검증' },
  { key: 'deploy', label: '배포' },
];

export default function BuildStatus() {
  const { id } = useParams<{ id: string }>();
  const { connected, progress } = useWebSocket(id);
  const [logs] = useState<string[]>([]);

  const currentStep = progress?.phase || 'setup';
  const currentStepIdx = steps.findIndex((s) => s.key === currentStep);

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
          {connected ? '연결됨' : '연결 중...'}
        </span>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* Step Progress */}
        <div className="mb-8">
          {steps.map((step, idx) => {
            const isComplete = idx < currentStepIdx;
            const isCurrent = idx === currentStepIdx;

            return (
              <div key={step.key} className="flex items-start gap-4 mb-4">
                <div className="flex flex-col items-center">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                      isComplete
                        ? 'bg-green-600 text-white'
                        : isCurrent
                          ? 'bg-yellow-500 text-black animate-pulse'
                          : 'bg-gray-800 text-gray-600'
                    }`}
                  >
                    {isComplete ? '✓' : idx + 1}
                  </div>
                  {idx < steps.length - 1 && (
                    <div
                      className={`w-0.5 h-8 ${
                        isComplete ? 'bg-green-600' : 'bg-gray-800'
                      }`}
                    />
                  )}
                </div>
                <div className="pt-1">
                  <p
                    className={`font-medium ${
                      isComplete
                        ? 'text-green-400'
                        : isCurrent
                          ? 'text-yellow-400'
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
                </div>
              </div>
            );
          })}
        </div>

        {/* Stats */}
        {progress && (
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <p className="text-gray-500 text-xs mb-1">생성된 파일</p>
              <p className="text-white text-xl font-bold">
                {progress.files_created}/{progress.files_total}
              </p>
            </div>
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <p className="text-gray-500 text-xs mb-1">경과 시간</p>
              <p className="text-white text-xl font-bold">
                {Math.floor(progress.elapsed_seconds / 60)}분{' '}
                {progress.elapsed_seconds % 60}초
              </p>
            </div>
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <p className="text-gray-500 text-xs mb-1">진행률</p>
              <p className="text-white text-xl font-bold">
                {progress.progress_percent}%
              </p>
            </div>
          </div>
        )}

        {/* Logs */}
        <div>
          <h3 className="text-gray-400 text-sm mb-3">실시간 빌드 로그</h3>
          <BuildLog logs={logs} />
        </div>
      </main>
    </div>
  );
}
