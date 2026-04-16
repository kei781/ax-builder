import { useEffect, useRef, useState } from 'react';

interface BuildLogProps {
  logs: string[];
}

export default function BuildLog({ logs }: BuildLogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  // 사용자가 위로 스크롤하면 자동스크롤 중지
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setUserScrolled(!atBottom);
  };

  // 로그 추가 시 컨테이너 내부만 스크롤 (페이지 스크롤 안 함)
  useEffect(() => {
    if (!userScrolled && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, userScrolled]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="bg-gray-950 border border-gray-300 dark:border-gray-800 rounded-lg p-4 h-64 overflow-y-auto font-mono text-xs text-gray-400"
    >
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
    </div>
  );
}
