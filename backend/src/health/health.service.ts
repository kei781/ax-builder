import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import Docker from 'dockerode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

type Status = 'ok' | 'degraded' | 'down';

interface ServiceHealth {
  status: Status;
  message: string;
  latency_ms?: number;
}

export interface HealthResult {
  backend: ServiceHealth;
  database: ServiceHealth;
  docker: ServiceHealth;
  hermes: ServiceHealth;
}

@Injectable()
export class HealthService {
  private readonly docker: Docker;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
  }

  async checkAll(): Promise<HealthResult> {
    const [database, docker, hermes] = await Promise.all([
      this.checkDatabase(),
      this.checkDocker(),
      this.checkHermes(),
    ]);

    return {
      backend: { status: 'ok', message: '정상 작동 중' },
      database,
      docker,
      hermes,
    };
  }

  private async checkDatabase(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      const latency = Date.now() - start;
      if (latency > 1000) {
        return { status: 'degraded', message: `응답 느림 (${latency}ms)`, latency_ms: latency };
      }
      return { status: 'ok', message: '정상', latency_ms: latency };
    } catch (err: any) {
      return { status: 'down', message: err.message || 'DB 연결 실패' };
    }
  }

  private async checkDocker(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      await this.docker.ping();
      const latency = Date.now() - start;
      if (latency > 2000) {
        return { status: 'degraded', message: `응답 느림 (${latency}ms)`, latency_ms: latency };
      }
      return { status: 'ok', message: '정상', latency_ms: latency };
    } catch (err: any) {
      return { status: 'down', message: 'Docker 데몬에 연결할 수 없습니다' };
    }
  }

  private async checkHermes(): Promise<ServiceHealth> {
    const start = Date.now();
    const hermesVenvPython = `${process.env['HOME']}/.hermes/hermes-agent/venv/bin/python3`;
    try {
      const { stdout } = await execAsync(
        `${hermesVenvPython} -c "from run_agent import AIAgent; print('ok')"`,
        { timeout: 10000 },
      );
      const latency = Date.now() - start;
      if (stdout.trim() === 'ok') {
        return { status: 'ok', message: '정상', latency_ms: latency };
      }
      return { status: 'degraded', message: '응답 이상', latency_ms: latency };
    } catch {
      return { status: 'down', message: 'Hermes Agent 미설치 또는 import 실패' };
    }
  }
}
