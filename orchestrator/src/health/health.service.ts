import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import Docker from 'dockerode';

type Status = 'ok' | 'degraded' | 'down';

interface ServiceHealth {
  status: Status;
  message: string;
  latency_ms?: number;
}

export interface HealthResult {
  orchestrator: ServiceHealth;
  database: ServiceHealth;
  planning_agent: ServiceHealth;
  docker: ServiceHealth;
}

@Injectable()
export class HealthService {
  private readonly docker: Docker;
  private readonly planningAgentUrl: string;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    this.planningAgentUrl = this.config.get<string>(
      'PLANNING_AGENT_URL',
      'http://127.0.0.1:4100',
    );
  }

  async checkAll(): Promise<HealthResult> {
    const [database, planningAgent, docker] = await Promise.all([
      this.checkDatabase(),
      this.checkPlanningAgent(),
      this.checkDocker(),
    ]);

    return {
      orchestrator: { status: 'ok', message: '정상 작동 중' },
      database,
      planning_agent: planningAgent,
      docker,
    };
  }

  private async checkDatabase(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      const latency = Date.now() - start;
      if (latency > 1000) {
        return {
          status: 'degraded',
          message: `응답 느림 (${latency}ms)`,
          latency_ms: latency,
        };
      }
      return { status: 'ok', message: '정상', latency_ms: latency };
    } catch (err: any) {
      return { status: 'down', message: err.message || 'DB 연결 실패' };
    }
  }

  private async checkPlanningAgent(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.planningAgentUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const latency = Date.now() - start;
      if (!res.ok) {
        return {
          status: 'down',
          message: `HTTP ${res.status}`,
          latency_ms: latency,
        };
      }
      const data = await res.json();
      return {
        status: data.ok ? 'ok' : 'degraded',
        message: data.ok
          ? `${data.backend} (${data.slots?.[0]?.model ?? '?'})`
          : 'unhealthy',
        latency_ms: latency,
      };
    } catch {
      return { status: 'down', message: 'Planning Agent 연결 실패' };
    }
  }

  private async checkDocker(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      await this.docker.ping();
      const latency = Date.now() - start;
      if (latency > 2000) {
        return {
          status: 'degraded',
          message: `응답 느림 (${latency}ms)`,
          latency_ms: latency,
        };
      }
      return { status: 'ok', message: '정상', latency_ms: latency };
    } catch {
      return { status: 'down', message: 'Docker 데몬 연결 불가' };
    }
  }
}
