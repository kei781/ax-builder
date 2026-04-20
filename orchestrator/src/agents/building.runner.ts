import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

import { Project } from '../projects/entities/project.entity.js';
import { StateMachineService } from '../state-machine/state-machine.service.js';
import { HandoffsService } from '../handoffs/handoffs.service.js';
import { BuildsService } from '../builds/builds.service.js';
import { DockerService } from '../infra/docker.service.js';
import { PortAllocatorService } from '../infra/port-allocator.service.js';
import { BuildGateway } from '../websocket/build.gateway.js';
import { EnvsService } from '../envs/envs.service.js';
import { EnvDeployService } from '../envs/env-deploy.service.js';
import type { AgentEvent } from '../websocket/events.js';

/**
 * Building Agent lifecycle manager.
 *
 * Spawns `building-agent/orchestrator.py`, pipes stderr JSON-line events
 * into BuildGateway, persists Build/BuildPhase rows, and handles exit:
 *   code 0 → deployed
 *   code 2 → bounce-back (planning)
 *   else   → failed
 */
@Injectable()
export class BuildingRunner {
  private readonly logger = new Logger(BuildingRunner.name);
  private readonly buildingAgentDir: string;
  private readonly buildingAgentPython: string;

  /** project_id → active subprocess (one concurrent build per project). */
  readonly processes = new Map<string, ChildProcess>();

  /** project_id → phase tracking state for DB writes. */
  private readonly phaseIds = new Map<string, Map<string, string>>();

  /**
   * project_id → 빌드 중 수집된 bounce-back용 gap_list.
   * `error` / `phase_failure` 이벤트의 `gap_list`를 누적해뒀다가 handleExit(code=2)에서
   * `builds.bounce_reason_gap_list`로 영속. 프론트 chat 배너에서 읽어 표시.
   */
  private readonly bounceGaps = new Map<string, string[]>();

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    private readonly stateMachine: StateMachineService,
    private readonly handoffs: HandoffsService,
    private readonly builds: BuildsService,
    private readonly docker: DockerService,
    private readonly portAllocator: PortAllocatorService,
    private readonly gateway: BuildGateway,
    private readonly envs: EnvsService,
    private readonly envDeploy: EnvDeployService,
  ) {
    this.buildingAgentDir = path.resolve(process.cwd(), '..', 'building-agent');
    this.buildingAgentPython = path.resolve(
      this.buildingAgentDir,
      'venv',
      'bin',
      'python3',
    );
  }

  async start(
    projectId: string,
  ): Promise<{ message: string; state: string; build_id: string }> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');

    if (project.state !== 'plan_ready') {
      throw new BadRequestException(
        `plan_ready 상태에서만 빌드를 시작할 수 있습니다. (현재: ${project.state})`,
      );
    }
    if (!project.current_session_id) {
      throw new BadRequestException('세션이 없습니다.');
    }

    const handoff = await this.handoffs.latestForSession(project.current_session_id);
    if (!handoff || !this.handoffs.isReadyForBuild(handoff)) {
      throw new BadRequestException('핸드오프가 빌드 조건을 충족하지 않습니다.');
    }

    if (this.processes.has(projectId)) {
      throw new BadRequestException('이미 빌드가 진행 중입니다.');
    }

    // Concurrency limits (ARCHITECTURE §10.1):
    //   - 1 concurrent build per user (owner_id)
    //   - 3 concurrent builds system-wide
    const activeBuildCount = this.processes.size;
    if (activeBuildCount >= 3) {
      throw new BadRequestException(
        '시스템 전체 동시 빌드 한도(3개)에 도달했습니다. 잠시 후 다시 시도해주세요.',
      );
    }
    // Per-user check: count builds owned by same owner
    const ownerBuilds = await this.projectRepo
      .createQueryBuilder('p')
      .where('p.owner_id = :ownerId', { ownerId: project.owner_id })
      .andWhere('p.state IN (:...states)', { states: ['building', 'qa'] })
      .getCount();
    if (ownerBuilds >= 1) {
      throw new BadRequestException(
        '유저당 동시 빌드는 1개까지 가능합니다. 기존 빌드가 완료된 후 시도해주세요.',
      );
    }

    // Transition to building
    await this.stateMachine.transition(projectId, 'building', 'build started');

    // Create build record
    const nextVersion = project.current_version + 1;
    const build = await this.builds.openBuild(
      projectId,
      project.current_session_id,
      nextVersion,
    );

    // Spawn the Python Building Agent
    const args = JSON.stringify({
      project_id: projectId,
      project_path: project.project_path,
      session_id: project.current_session_id,
      build_id: build.id,
    });

    const nvmBin = `${process.env['HOME']}/.nvm/versions/node/${process.version}/bin`;
    const extendedPath = [nvmBin, '/usr/local/bin', process.env['PATH']].join(':');

    const proc = spawn(
      this.buildingAgentPython,
      [path.join(this.buildingAgentDir, 'orchestrator.py'), args],
      {
        cwd: this.buildingAgentDir,
        env: { ...process.env, PATH: extendedPath },
      },
    );

    this.processes.set(projectId, proc);
    this.phaseIds.set(projectId, new Map());
    this.bounceGaps.set(projectId, []);

    proc.stdout?.on('data', (data: Buffer) => {
      // Building agent writes nothing important on stdout; capture for logs.
      const text = data.toString().trim();
      if (text) {
        this.logger.debug(`[ba-stdout/${projectId}] ${text.slice(0, 200)}`);
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        // Try JSON event first
        try {
          const event: AgentEvent = JSON.parse(line);
          if (event.event_type) {
            this.handleBuildEvent(projectId, build.id, event);
            continue;
          }
        } catch {
          // Not JSON — human log line.
        }
        // Forward raw log line to frontend
        this.gateway.emit({
          agent: 'building',
          project_id: projectId,
          build_id: build.id,
          event_type: 'log',
          payload: { line },
        });
      }
    });

    proc.on('close', (code) => {
      this.processes.delete(projectId);
      this.phaseIds.delete(projectId);
      void this.handleExit(projectId, build.id, project.current_session_id!, code);
    });

    proc.on('error', (err) => {
      this.processes.delete(projectId);
      this.phaseIds.delete(projectId);
      this.logger.error(`Building agent spawn error: ${err.message}`);
      void this.handleExit(projectId, build.id, project.current_session_id!, 1);
    });

    return {
      message: '빌드를 시작했습니다.',
      state: 'building',
      build_id: build.id,
    };
  }

  async cancel(projectId: string): Promise<{ message: string; state: string }> {
    const proc = this.processes.get(projectId);
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      this.processes.delete(projectId);
    }

    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');
    if (project.state !== 'building' && project.state !== 'qa') {
      throw new BadRequestException(`빌드 중이 아닙니다. (현재: ${project.state})`);
    }

    const updated = await this.stateMachine.transition(
      projectId,
      'failed',
      'user cancelled',
    );
    this.gateway.emit({
      agent: 'building',
      project_id: projectId,
      event_type: 'error',
      payload: { message: 'cancelled by user' },
    });
    return { message: '빌드를 중단했습니다.', state: updated.state };
  }

  async status(projectId: string): Promise<Record<string, unknown>> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) return { active: false, phase: null, state: null };
    const active = this.processes.has(projectId);

    // Fetch latest build + phases from DB so the UI can restore on page load
    const latestBuild = await this.builds.getLatestBuild(projectId);
    const phases = latestBuild
      ? await this.builds.getPhasesForBuild(latestBuild.id)
      : [];

    return {
      active,
      state: project.state,
      build: latestBuild
        ? {
            id: latestBuild.id,
            status: latestBuild.status,
            started_at: latestBuild.started_at,
            finished_at: latestBuild.finished_at,
            bounce_reason_gap_list: latestBuild.bounce_reason_gap_list,
          }
        : null,
      phases: phases.map((p) => ({
        idx: p.idx,
        name: p.name,
        status: p.status,
        started_at: p.started_at,
        finished_at: p.finished_at,
      })),
    };
  }

  // ---------- Private ----------

  private handleBuildEvent(
    projectId: string,
    buildId: string,
    event: AgentEvent,
  ): void {
    // Always forward to frontend.
    this.gateway.emit(event);

    // Persist interesting events.
    const et = event.event_type;
    const p = (event.payload ?? {}) as Record<string, unknown>;

    if (et === 'phase_start') {
      const phaseName = event.phase ?? String(p['idx'] ?? '');
      this.builds
        .recordPhase({
          build_id: buildId,
          idx: Number(p['idx'] ?? 0),
          name: phaseName,
          status: 'running',
          input_prompt: null,
        })
        .then((row) => {
          this.phaseIds.get(projectId)?.set(phaseName, row.id);
        })
        .catch((e) => this.logger.warn(`phase_start persist: ${e.message}`));
    }

    if (et === 'phase_end') {
      const phaseName = event.phase ?? '';
      const phaseId = this.phaseIds.get(projectId)?.get(phaseName);
      if (phaseId) {
        const ok = p['ok'] === true;
        // QA phases emit {detail, gap_list}. Code phases emit {stdout_tail, stderr_tail}.
        // Both must land in output_log so the build viewer has something to show.
        const gapList = Array.isArray(p['gap_list']) ? p['gap_list'] : [];
        const fragments = [
          p['stdout_tail'] ?? '',
          p['stderr_tail'] ?? '',
          p['detail'] ?? '',
          gapList.length ? `gap_list:\n- ${gapList.join('\n- ')}` : '',
        ].filter(Boolean);
        this.builds
          .updatePhase(phaseId, {
            status: ok ? 'success' : 'failed',
            output_log: fragments.join('\n---\n').slice(0, 10000),
            finished_at: new Date(),
          })
          .catch((e) => this.logger.warn(`phase_end persist: ${e.message}`));
      }
    }

    if (et === 'error' || et === 'completion') {
      this.builds
        .recordAgentEvent({
          project_id: projectId,
          build_id: buildId,
          agent: 'building',
          event_type: et,
          payload: event.payload ?? null,
        })
        .catch((e) => this.logger.warn(`agent_log persist: ${e.message}`));
    }

    // bounce 이유로 쓸 gap_list 누적.
    //   - error 이벤트의 payload.gap_list (phase_failure / qa_failure 등)
    //   - phase_end 이벤트의 payload.gap_list (QA path)
    if (et === 'error' || et === 'phase_end') {
      const gapList = Array.isArray(p['gap_list'])
        ? (p['gap_list'] as unknown[]).map((x) => String(x))
        : [];
      if (gapList.length) {
        const bucket = this.bounceGaps.get(projectId) ?? [];
        bucket.push(...gapList);
        this.bounceGaps.set(projectId, bucket);
      }
    }
  }

  private async handleExit(
    projectId: string,
    buildId: string,
    sessionId: string,
    code: number | null,
  ): Promise<void> {
    this.logger.log(`Building agent exited: code=${code} project=${projectId}`);

    if (code === 0) {
      // ADR 0005 mock-first: build success always → deploy with whatever env
      // is currently resolved. user-required 값이 없어도 mock 상태로 배포.
      // 실제 값 입력은 배포 후 유지보수 모드에서 언제든.
      this.bounceGaps.delete(projectId);
      await this.builds.closeBuild(buildId, 'success');
      const proj = await this.projectRepo.findOne({ where: { id: projectId } });
      if (!proj) return;

      try {
        await this.envs.syncFromExample(projectId);
      } catch (err: any) {
        // provider-key violation 등 — schema 자체가 잘못됐으므로 planning 반송.
        this.logger.warn(
          `env sync failed for ${projectId}: ${err?.message ?? err}`,
        );
        try {
          await this.stateMachine.transition(
            projectId,
            'planning',
            `env sync bounce: ${err?.message ?? 'unknown'}`,
          );
        } catch {
          /* ignore */
        }
        this.gateway.emit({
          agent: 'building',
          project_id: projectId,
          event_type: 'error',
          payload: {
            kind: 'env_schema_violation',
            message: err?.message ?? 'env 스키마가 잘못됐어요.',
          },
        });
        return;
      }

      // Proceed to deploy — mock-first: user-required 유무와 무관.
      try {
        await this.stateMachine.transition(
          projectId,
          'env_qa',
          'mock-first deploy',
        );
      } catch {
        /* ignore — 이미 env_qa였을 수도 있음 */
      }
      await this.envDeploy.applyAndDeploy(projectId);
    } else if (code === 2) {
      // Bounce-back to Planning. 수집한 gap_list를 DB로 영속화해서
      // 프론트 chat 페이지 배너가 "왜 돌아왔는지" 표시할 수 있게.
      const gaps = this.bounceGaps.get(projectId) ?? [];
      this.bounceGaps.delete(projectId);
      await this.builds.closeBuild(
        buildId,
        'bounced',
        gaps.length
          ? gaps
          : ['빌드가 반송됐습니다. 상세 사유가 기록되지 않았습니다.'],
      );
      try {
        await this.stateMachine.transition(
          projectId,
          'planning',
          'bounce-back: build failed',
        );
      } catch {
        // State might have been transitioned already by a cancel.
      }
      this.gateway.emit({
        agent: 'building',
        project_id: projectId,
        event_type: 'progress',
        phase: 'bounce_back',
        payload: {
          detail: '빌드 실패 — 기획 대화로 돌아갑니다.',
          gap_list: gaps,
        },
      });
    } else {
      // Unrecoverable failure
      this.bounceGaps.delete(projectId);
      await this.builds.closeBuild(buildId, 'failed', [
        `Building Agent가 비정상 종료했습니다 (exit code ${code})`,
        '빌드 로그를 확인하고, 기획 문서에 누락된 정보가 있다면 보완해주세요.',
      ]);
      try {
        await this.stateMachine.transition(projectId, 'failed', `exit code ${code}`);
      } catch {
        // ignore
      }
    }
  }
}
