import { useState, useEffect } from 'react';
import client from '../api/client';

interface ServiceHealth {
  status: 'ok' | 'degraded' | 'down';
  message: string;
  latency_ms?: number;
}

interface HealthData {
  orchestrator: ServiceHealth;
  database: ServiceHealth;
  planning_agent: ServiceHealth;
  building_agent: ServiceHealth;
  docker: ServiceHealth;
}

const statusDot: Record<string, string> = {
  ok: 'bg-green-500',
  degraded: 'bg-yellow-500',
  down: 'bg-red-500',
};

const statusLabel: Record<string, string> = {
  ok: '정상',
  degraded: '느림',
  down: '중단',
};

function Dot({ status }: { status: string }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${statusDot[status] || 'bg-gray-600'}`}
    />
  );
}

export default function InfraStatus() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await client.get('/health');
        setHealth(res.data);
        setError(false);
      } catch {
        setError(true);
        setHealth(null);
      }
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  if (error || !health) {
    return (
      <div className="flex items-center gap-3 px-4 py-1.5 bg-gray-100 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-800 text-xs">
        <span className="text-gray-500">인프라</span>
        <span className="flex items-center gap-1.5 text-gray-500">
          <Dot status="down" />
          Orchestrator 연결 안 됨
        </span>
      </div>
    );
  }

  const services = [
    { key: 'orchestrator', label: 'Orchestrator', data: health.orchestrator },
    { key: 'database', label: 'Database', data: health.database },
    { key: 'planning_agent', label: 'Planning Agent', data: health.planning_agent },
    { key: 'building_agent', label: 'Building Agent', data: health.building_agent },
    { key: 'docker', label: 'Docker', data: health.docker },
  ];

  return (
    <div className="flex items-center gap-4 px-4 py-1.5 bg-gray-100 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-800 text-xs">
      <span className="text-gray-500">인프라</span>
      {services.map((s) => (
        <span
          key={s.key}
          className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400"
          title={`${s.data.message}${s.data.latency_ms ? ` (${s.data.latency_ms}ms)` : ''}`}
        >
          <Dot status={s.data.status} />
          {s.label}
          {s.data.status !== 'ok' && (
            <span className={s.data.status === 'degraded' ? 'text-yellow-500' : 'text-red-500'}>
              {s.data.message}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
