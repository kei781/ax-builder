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
 * Turns a filled-in set of env values into a running container.
 *
 * Called:
 *   - By EnvsController.submit after the user fills user-required vars
 *   - By BuildingRunner on initial build when there's nothing pending
 *
 * Flow:
 *   1. State → env_qa (or directly deploy when awaiting_env skipped)
 *   2. Write .env to project_path (including system-injected values)
 *   3. Destroy previous container if any
 *   4. Allocate host port + create new container (binds 3000 internal)
 *   5. Start + health-poll for 30s
 *   6. Success → deployed (store port, container_id, bump version)
 *   7. Fail → back to awaiting_env (or failed for first-time deploy without env)
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

  /**
   * Primary entry: take a project sitting in `awaiting_env` (or a fresh
   * post-build deploy with 0 user-required), write .env, and deploy.
   */
  async applyAndDeploy(projectId: string): Promise<void> {
    const proj = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!proj) return;

    // awaiting_env → env_qa (noop if we came from the building.runner
    // happy path where env was already clean and state is `qa`)
    if (proj.state === 'awaiting_env') {
      try {
        await this.stateMachine.transition(projectId, 'env_qa', 'user submitted env');
      } catch (err: any) {
        this.logger.warn(
          `state transition awaiting_env → env_qa failed: ${err?.message ?? err}`,
        );
      }
      this.gateway.emit({
        agent: 'building',
        project_id: projectId,
        event_type: 'phase_start',
        phase: 'env_qa',
        payload: { description: '환경변수를 적용하고 컨테이너를 다시 기동합니다.' },
      });
    }

    await this.envs.writeDotenv(projectId);

    // Clean up previous container (if any) — we're replacing it
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
      // No container to fetch logs from — hand the error text directly.
      await this.handleFailure(
        projectId,
        `container start failed: ${err?.message ?? 'unknown'}`,
      );
      return;
    }

    // Poll health for 30s
    const ok = await this.pollHealth(port, 30_000);
    if (!ok) {
      this.logger.warn(`health poll failed for project ${projectId} port ${port}`);
      // Grab logs BEFORE removing the container — classifier needs them.
      const logs = await this.docker.getLogs(containerId, 500);
      try {
        await this.docker.removeContainer(containerId);
      } catch {
        /* ignore */
      }
      await this.handleFailure(projectId, logs);
      return;
    }

    const newVersion = (proj.current_version ?? 0) + 1;
    await this.projectRepo.update(projectId, {
      current_version: newVersion,
      port,
      container_id: containerId,
      env_attempts: 0, // reset on successful deploy
    });
    await this.builds.createVersion(projectId, newVersion, containerId);

    try {
      await this.stateMachine.transition(projectId, 'deployed', 'env applied');
    } catch {
      /* ignore */
    }

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
   * ADR 0002 — run classifier, then route:
   *   env_rejected + attempts < 3 → awaiting_env (retry)
   *   env_rejected + attempts >= 3 → schema_bug → planning
   *   transient  → awaiting_env (user can hit "다시 시도")
   *   code_bug / unknown → planning (bounce-back, gap에 분류 근거 첨부)
   */
  private async handleFailure(
    projectId: string,
    containerLogs: string,
  ): Promise<void> {
    const proj = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!proj) return;

    const verdict = this.classifier.classify(containerLogs);
    this.logger.log(
      `env_qa classifier verdict for ${projectId}: ${verdict.kind} (${verdict.matched_rule ?? 'default'})`,
    );

    let nextState: 'awaiting_env' | 'planning' = 'awaiting_env';
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
        userMessage = '입력하신 값이 거부됐어요. 확인 후 다시 입력해주세요.';
      }
    } else if (verdict.kind === 'transient') {
      userMessage =
        '연결한 외부 서비스에서 응답이 없어요. 잠시 뒤 [다시 시도]를 눌러주세요.';
    } else if (verdict.kind === 'code_bug') {
      nextState = 'planning';
      userMessage = '앱 코드에 문제가 있어 기획을 다시 다듬어야 해요.';
    } else {
      // unknown → 안전하게 planning (ADR 0002 폴백)
      nextState = 'planning';
      userMessage = '원인을 특정하지 못했어요. 기획부터 점검합니다.';
    }

    try {
      if (proj.state === 'env_qa') {
        await this.stateMachine.transition(
          projectId,
          nextState,
          `classifier=${effectiveKind}`,
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
