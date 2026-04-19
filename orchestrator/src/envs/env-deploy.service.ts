import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as http from 'http';

import { Project } from '../projects/entities/project.entity.js';
import { StateMachineService } from '../state-machine/state-machine.service.js';
import { DockerService } from '../infra/docker.service.js';
import { PortAllocatorService } from '../infra/port-allocator.service.js';
import { BuildsService } from '../builds/builds.service.js';
import { BuildGateway } from '../websocket/build.gateway.js';
import { EnvsService } from './envs.service.js';
import {
  FailureClassifierService,
  FailureKind,
} from './failure-classifier.service.js';

const MAX_ENV_ATTEMPTS = 3;

type FailureKindEffective = FailureKind | 'schema_bug';

/**
 * Env-driven deploy/restart orchestration (ADR 0005 + 0006).
 *
 * Two entry modes:
 *
 * 1. **First-time deploy** (container_id == null): called from BuildingRunner
 *    post-build. Creates a fresh container with whatever env is currently
 *    set (mock-first: system-injected only is fine).
 *
 * 2. **Maintenance restart** (container_id != null, state == 'deployed'):
 *    called from `POST /env apply=true` or `POST /restart`. Uses
 *    `docker restart` on the existing container — no recreate, keeps
 *    rollback-for-free (ADR 0006 §D3).
 *
 * Failure routing (ADR 0005 override):
 *   - env_rejected / transient / unknown (non-code) → **stay deployed**,
 *     emit WS toast. Container already running with previous state if
 *     this was a maintenance restart; first-time deploy is rare to hit
 *     these kinds.
 *   - code_bug → `modifying` (dialog fix), not planning.
 *   - schema_bug (env_rejected ≥ 3 streak) → planning (극단).
 */
@Injectable()
export class EnvDeployService {
  private readonly logger = new Logger(EnvDeployService.name);

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    private readonly envs: EnvsService,
    private readonly stateMachine: StateMachineService,
    private readonly docker: DockerService,
    private readonly portAllocator: PortAllocatorService,
    private readonly builds: BuildsService,
    private readonly gateway: BuildGateway,
    private readonly classifier: FailureClassifierService,
  ) {}

  async applyAndDeploy(projectId: string): Promise<void> {
    const proj = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!proj?.project_path) return;

    const mode: 'maintenance' | 'fresh' =
      proj.state === 'deployed' && proj.container_id ? 'maintenance' : 'fresh';

    // Transition into env_qa (or stay if already there)
    try {
      if (proj.state !== 'env_qa') {
        await this.stateMachine.transition(
          projectId,
          'env_qa',
          mode === 'maintenance' ? 'maintenance restart' : 'fresh deploy',
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `transition → env_qa failed (${proj.state}): ${err?.message ?? err}`,
      );
    }

    this.gateway.emit({
      agent: 'building',
      project_id: projectId,
      event_type: 'phase_start',
      phase: 'env_qa',
      payload: {
        description:
          mode === 'maintenance'
            ? '환경변수 적용 후 컨테이너를 재시작합니다.'
            : '컨테이너를 새로 기동합니다.',
      },
    });

    await this.envs.writeDotenv(projectId);

    if (mode === 'maintenance') {
      await this.maintenanceRestart(projectId, proj.container_id!, proj.port!);
    } else {
      await this.freshDeploy(projectId, proj);
    }
  }

  /**
   * POST /restart entry — bounce the container after re-writing .env from
   * the current DB state. This ensures any DB-side env updates (including
   * newly-minted AI Gateway tokens) land in the container's env file.
   */
  async restartOnly(projectId: string): Promise<void> {
    const proj = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!proj?.container_id || !proj.port) {
      throw new Error('컨테이너가 없어 재시작할 수 없습니다.');
    }
    try {
      await this.stateMachine.transition(projectId, 'env_qa', 'manual restart');
    } catch {
      /* already in env_qa or transition denied — proceed anyway */
    }
    this.gateway.emit({
      agent: 'building',
      project_id: projectId,
      event_type: 'phase_start',
      phase: 'env_qa',
      payload: { description: '컨테이너 재시작 중...' },
    });
    await this.envs.writeDotenv(projectId);
    await this.maintenanceRestart(projectId, proj.container_id, proj.port);
  }

  // -------- mode implementations --------

  private async freshDeploy(projectId: string, proj: Project): Promise<void> {
    // Clean up previous container (if any, e.g. retry after a freshDeploy failure)
    if (proj.container_id) {
      try {
        await this.docker.removeContainer(proj.container_id);
      } catch (err: any) {
        this.logger.warn(
          `remove previous container failed: ${err?.message ?? err}`,
        );
      }
    }

    let port: number;
    let containerId: string;
    try {
      port = await this.portAllocator.allocate();
      containerId = await this.docker.createContainer(
        projectId,
        proj.project_path!,
        port,
      );
      await this.docker.startContainer(containerId);
    } catch (err: any) {
      this.logger.error(`container create/start failed: ${err?.message ?? err}`);
      await this.handleFailure(
        projectId,
        `container start failed: ${err?.message ?? 'unknown'}`,
        'fresh',
      );
      return;
    }

    // Fresh deploy: container runs `npm install && npm start` inside.
    // npm install with native modules(better-sqlite3 등)은 수십 초 ~ 2분 소요.
    // 따라서 fresh 타임아웃은 넉넉히 2분으로 잡는다.
    const ok = await this.pollHealth(port, 120_000);
    if (!ok) {
      this.logger.warn(`health poll failed for project ${projectId} port ${port}`);
      const logs = await this.docker.getLogs(containerId, 500);
      try {
        await this.docker.removeContainer(containerId);
      } catch {
        /* ignore */
      }
      await this.handleFailure(projectId, logs, 'fresh');
      return;
    }

    const newVersion = (proj.current_version ?? 0) + 1;
    await this.projectRepo.update(projectId, {
      current_version: newVersion,
      port,
      container_id: containerId,
      env_attempts: 0,
    });
    await this.builds.createVersion(projectId, newVersion, containerId);

    try {
      await this.stateMachine.transition(projectId, 'deployed', 'fresh deploy ok');
    } catch {
      /* ignore */
    }

    this.emitCompletion(projectId, port, containerId);
  }

  private async maintenanceRestart(
    projectId: string,
    containerId: string,
    port: number,
  ): Promise<void> {
    try {
      await this.docker.restartContainer(containerId);
    } catch (err: any) {
      this.logger.error(`container restart failed: ${err?.message ?? err}`);
      await this.handleFailure(
        projectId,
        `container restart failed: ${err?.message ?? 'unknown'}`,
        'maintenance',
      );
      return;
    }

    const ok = await this.pollHealth(port, 10_000);
    if (!ok) {
      this.logger.warn(
        `maintenance restart health poll failed for ${projectId} port ${port}`,
      );
      const logs = await this.docker.getLogs(containerId, 500);
      await this.handleFailure(projectId, logs, 'maintenance');
      return;
    }

    await this.projectRepo.update(projectId, { env_attempts: 0 });
    try {
      await this.stateMachine.transition(projectId, 'deployed', 'maintenance restart ok');
    } catch {
      /* ignore */
    }
    this.emitCompletion(projectId, port, containerId);
  }

  private emitCompletion(
    projectId: string,
    port: number,
    containerId: string,
  ): void {
    this.gateway.emit({
      agent: 'building',
      project_id: projectId,
      event_type: 'completion',
      progress_percent: 100,
      payload: {
        detail: '배포 완료',
        state: 'deployed',
        port,
        container_id: containerId,
      },
    });
  }

  /**
   * ADR 0005 routing:
   *   env_rejected + attempts < 3 → stay deployed, toast
   *   env_rejected + attempts ≥ 3 → schema_bug → planning
   *   transient   → stay deployed, toast "다시 시도"
   *   code_bug    → modifying (대화 수정 세션)
   *   unknown     → code_bug 폴백 → modifying
   */
  private async handleFailure(
    projectId: string,
    containerLogs: string,
    mode: 'fresh' | 'maintenance',
  ): Promise<void> {
    const proj = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!proj) return;

    const verdict = this.classifier.classify(containerLogs);
    this.logger.log(
      `env_qa classifier verdict for ${projectId}: ${verdict.kind} (${verdict.matched_rule ?? 'default'}) mode=${mode}`,
    );

    let nextState: 'deployed' | 'modifying' | 'planning' | 'failed' = 'deployed';
    let effectiveKind: FailureKindEffective = verdict.kind;
    let userMessage: string;

    if (verdict.kind === 'env_rejected') {
      const nextAttempts = (proj.env_attempts ?? 0) + 1;
      await this.projectRepo.update(projectId, { env_attempts: nextAttempts });
      if (nextAttempts >= MAX_ENV_ATTEMPTS) {
        effectiveKind = 'schema_bug';
        nextState = 'planning';
        userMessage = `같은 항목에서 ${MAX_ENV_ATTEMPTS}회 연속 거부됐어요. 기획부터 다시 점검합니다.`;
      } else {
        nextState = mode === 'fresh' ? 'failed' : 'deployed';
        userMessage = '입력하신 값이 거부됐어요. 확인 후 다시 입력해주세요.';
      }
    } else if (verdict.kind === 'transient') {
      nextState = mode === 'fresh' ? 'failed' : 'deployed';
      userMessage =
        '연결한 외부 서비스에서 응답이 없어요. 잠시 뒤 다시 시도해주세요.';
    } else if (verdict.kind === 'code_bug') {
      nextState = mode === 'fresh' ? 'planning' : 'modifying';
      userMessage =
        mode === 'fresh'
          ? '앱 코드에 문제가 있어 기획을 다시 다듬어야 해요.'
          : '앱 코드에 문제가 있어요. 대화로 수정해보세요.';
    } else {
      // unknown → 안전하게 code_bug로 폴백
      nextState = mode === 'fresh' ? 'planning' : 'modifying';
      userMessage = '원인을 특정하지 못했어요. 세부 내용을 확인해주세요.';
    }

    try {
      if (proj.state === 'env_qa') {
        await this.stateMachine.transition(
          projectId,
          nextState,
          `classifier=${effectiveKind} mode=${mode}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`state transition failed: ${err?.message ?? err}`);
    }

    this.gateway.emit({
      agent: 'building',
      project_id: projectId,
      event_type: 'error',
      payload: {
        kind: 'env_qa_failure',
        classifier: effectiveKind,
        matched_rule: verdict.matched_rule,
        message: userMessage,
        reason_snippet: verdict.reason,
        next_state: nextState,
        mode,
      },
    });
  }

  private pollHealth(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
        if (Date.now() > deadline) return resolve(false);
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'HEAD',
            path: '/',
            timeout: 2000,
          },
          (res) => {
            const code = res.statusCode ?? 0;
            if (code >= 200 && code < 500) return resolve(true);
            setTimeout(attempt, 800);
          },
        );
        req.on('error', () => setTimeout(attempt, 800));
        req.on('timeout', () => {
          req.destroy();
          setTimeout(attempt, 800);
        });
        req.end();
      };
      attempt();
    });
  }
}
