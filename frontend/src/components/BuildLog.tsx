import { useEffect, useRef } from 'react';

interface BuildLogProps {
  logs: string[];
}

export default function BuildLog({ logs }: BuildLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="bg-gray-950 border border-gray-300 dark:border-gray-800 rounded-lg p-4 h-64 overflow-y-auto font-mono text-xs text-gray-400">
      {logs.length === 0 ? (
        <p className="text-gray-600">로그 대기 중...</p>
      ) : (
        logs.map((log, i) => (
          <div key={i} className="py-0.5">
            <span className="text-gray-600 mr-2">&gt;</span>
            {log}
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}
