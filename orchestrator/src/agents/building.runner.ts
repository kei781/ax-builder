import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not, IsNull } from 'typeorm';
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
import { FailureClassifierService } from '../envs/failure-classifier.service.js';
import type { AgentEvent } from '../websocket/events.js';

/**
 * Building Agent lifecycle manager.
 *
 * Spawns `building-agent/orchestrator.py`, pipes stderr JSON-line events
 * into BuildGateway, persists Build/BuildPhase rows, and handles exit:
 *   code 0 → deployed (또는 update 라인은 update_qa 경유)
 *   code 2 → bounce-back (첫 빌드: planning / 업데이트: planning_update)
 *   else   → failed
 *
 * ADR 0008 — 두 라인 지원:
 *   plan_ready → building  (mode='build', 첫 빌드)
 *   update_ready → updating (mode='update', 업데이트)
 */
export type BuildMode = 'build' | 'update';

@Injectable()
export class BuildingRunner implements OnModuleInit {
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

  /** project_id → 이번 실행의 모드. handleExit에서 분기용. */
  private readonly modes = new Map<string, BuildMode>();

  /**
   * project_id → QA가 관찰한 primary endpoint 목록.
   * QA phase_end에서 수집해 env-deploy.applyAndDeploy에 넘긴다.
   * env-deploy는 project_versions.primary_endpoints로 영속.
   */
  private readonly primaryEndpoints = new Map<string, string[]>();

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
    private readonly classifier: FailureClassifierService,
  ) {
    this.buildingAgentDir = path.resolve(process.cwd(), '..', 'building-agent');
    this.buildingAgentPython = path.resolve(
      this.buildingAgentDir,
      'venv',
      'bin',
      'python3',
    );
  }

  /**
   * Startup 훅 — nest start --watch로 hot-reload되거나 프로세스가 kill 당해서
   * 재시작될 때, DB엔 `running` 상태인 빌드가 남아있지만 자식 프로세스는 이미
   * 사라진 "고아 빌드"를 정리한다.
   *
   * 판단 기준: this.processes Map은 비어있는데 (방금 시작했으니 당연히 비어있음)
   * DB에는 building/qa/updating/update_qa state 프로젝트 + running build가 있음.
   * 이 조합은 확실한 고아. 프로젝트 상태를 `failed`로, 빌드/phase를 `cancelled`로.
   *
   * update 라인에서 고아가 나온 경우는 previous_container_id가 있으면 deployed로
   * 복구하는 게 더 친절하지만, previous 컨테이너가 실제 살아있는지 확인 필요
   * (다른 세션이 정리했을 수 있음). MVP에선 안전하게 `failed` — 유저가 대시보드에서
   * 수동으로 재시도하거나 프로젝트 삭제 결정.
   */
  async onModuleInit(): Promise<void> {
    // 1) state 기반 고아 빌드 정리
    const STUCK_STATES = ['building', 'qa', 'updating', 'update_qa'] as const;
    const orphaned = await this.projectRepo.find({
      where: { state: In([...STUCK_STATES]) },
    });
    if (orphaned.length > 0) {
      this.logger.warn(
        `onModuleInit: 고아 빌드 ${orphaned.length}건 감지 — state를 failed로 정리`,
      );
      for (const proj of orphaned) {
        try {
          // 이 빌드의 최신 build row도 cancelled로.
          const latestBuild = await this.builds.getLatestBuild(proj.id);
          if (latestBuild && latestBuild.status === 'running') {
            await this.builds.closeBuild(latestBuild.id, 'cancelled', [
              'orchestrator 재시작으로 빌드 프로세스가 고아가 됐어요. "다시 빌드"로 재시도하세요.',
            ]);
            // 진행 중이던 phase도 정리.
            const phases = await this.builds.getPhasesForBuild(latestBuild.id);
            for (const ph of phases) {
              if (ph.status === 'running') {
                await this.builds.updatePhase(ph.id, {
                  status: 'cancelled',
                  finished_at: new Date(),
                  output_log:
                    (ph.output_log ?? '') +
                    '\n[orchestrator 재시작으로 자동 정리]',
                });
              }
            }
          }
          // 업데이트 라인이면 previous 컨테이너로 복구 (불변식 유지). 첫 빌드
          // 라인이면 좀비 컨테이너 정리.
          const isUpdate = proj.state === 'updating' || proj.state === 'update_qa';
          if (isUpdate && proj.previous_container_id) {
            await this.rollbackToPrevious(proj.id);
          } else {
            await this.cleanupFailedContainer(proj.id);
          }
          await this.stateMachine.transition(proj.id, 'failed', 'orphaned on restart');
          this.logger.log(`  - ${proj.id} (${proj.state} → failed)`);
        } catch (err: any) {
          this.logger.warn(
            `  - ${proj.id} 정리 실패: ${err?.message ?? err}`,
          );
        }
      }
    }

    // 2) state는 정상인데 좀비 컨테이너만 남은 경우 정리
    // (회고 §7.5 — `failed` 상태인데 container_id가 살아있는 케이스가 오늘 포트
    // 충돌의 직접 원인이었음. 과거 버그로 이런 row가 누적됐을 수 있으니 startup
    // 때 sweep.)
    const zombieFailedWithContainer = await this.projectRepo.find({
      where: { state: 'failed', container_id: Not(IsNull()) },
    });
    if (zombieFailedWithContainer.length > 0) {
      this.logger.warn(
        `onModuleInit: failed 상태에 살아있는 컨테이너 ${zombieFailedWithContainer.length}건 감지 — 정리`,
      );
      for (const proj of zombieFailedWithContainer) {
        try {
          await this.cleanupFailedContainer(proj.id);
          this.logger.log(`  - ${proj.id}: zombie container removed`);
        } catch (err: any) {
          this.logger.warn(`  - ${proj.id} 좀비 정리 실패: ${err?.message ?? err}`);
        }
      }
    }
  }

  async start(
    projectId: string,
  ): Promise<{ message: string; state: string; build_id: string; mode: BuildMode }> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');

    // ADR 0008 — 두 진입 상태 중 하나만 허용.
    let mode: BuildMode;
    if (project.state === 'plan_ready') {
      mode = 'build';
    } else if (project.state === 'update_ready') {
      mode = 'update';
    } else {
      throw new BadRequestException(
        `plan_ready 또는 update_ready 상태에서만 빌드를 시작할 수 있습니다. (현재: ${project.state})`,
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
    // Per-user check: count builds/updates owned by same owner
    const ownerBuilds = await this.projectRepo
      .createQueryBuilder('p')
      .where('p.owner_id = :ownerId', { ownerId: project.owner_id })
      .andWhere('p.state IN (:...states)', {
        states: ['building', 'qa', 'updating', 'update_qa'],
      })
      .getCount();
    if (ownerBuilds >= 1) {
      throw new BadRequestException(
        '유저당 동시 빌드는 1개까지 가능합니다. 기존 빌드가 완료된 후 시도해주세요.',
      );
    }

    // ADR 0008 §D4 — update 모드: 롤백용 previous_* 백업 먼저.
    // updating 전이 이후 실패해도 env-deploy.handleFailure가 이 값으로 복구.
    if (mode === 'update') {
      await this.projectRepo.update(projectId, {
        previous_container_id: project.container_id,
        previous_version: project.current_version,
      });
    }

    // Transition: build→building, update→updating.
    const nextState = mode === 'build' ? 'building' : 'updating';
    await this.stateMachine.transition(projectId, nextState, `${mode} started`);

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
      mode, // 'build' | 'update' — phase_planner/phase_runner가 프롬프트 분기
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
    this.modes.set(projectId, mode);

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
      // spawn error는 운영자 문제 — 롤백 경로가 필요하면 handleExit이 결정.
      void this.handleExit(projectId, build.id, project.current_session_id!, 1);
    });

    // modes 정리는 handleExit 내부에서 — close 이전에 지우면 exit 핸들러가 모드 정보 없이 동작.

    return {
      message: mode === 'update' ? '업데이트를 시작했습니다.' : '빌드를 시작했습니다.',
      state: nextState,
      build_id: build.id,
      mode,
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
    const active =
      project.state === 'building' ||
      project.state === 'qa' ||
      project.state === 'updating' ||
      project.state === 'update_qa';
    if (!active) {
      throw new BadRequestException(`빌드 중이 아닙니다. (현재: ${project.state})`);
    }

    // update 라인에서 취소한 경우: 이전 컨테이너/버전이 있으면 deployed로 롤백.
    // 첫 빌드 라인은 배포된 적이 없으므로 failed로 종결.
    const isUpdate = project.state === 'updating' || project.state === 'update_qa';
    const canRollback =
      isUpdate && project.previous_container_id && project.previous_version !== null;
    const nextState = canRollback ? 'deployed' : 'failed';

    if (canRollback) {
      await this.projectRepo.update(projectId, {
        container_id: project.previous_container_id,
        current_version: project.previous_version!,
        previous_container_id: null,
        previous_version: null,
      });
    } else {
      // 첫 빌드 라인 취소: 좀비 컨테이너 정리 (회고 §7.5).
      // 빌드 도중 취소면 보통 container_id는 null이지만, env_qa 진행 중 취소
      // 같은 edge case에서 남아있을 수 있음.
      await this.cleanupFailedContainer(projectId);
    }

    const updated = await this.stateMachine.transition(
      projectId,
      nextState,
      'user cancelled',
    );
    this.gateway.emit({
      agent: 'building',
      project_id: projectId,
      event_type: 'error',
      payload: {
        message: canRollback
          ? '업데이트를 중단하고 이전 버전을 유지했어요.'
          : 'cancelled by user',
      },
    });
    return {
      message: canRollback ? '업데이트를 중단했습니다.' : '빌드를 중단했습니다.',
      state: updated.state,
    };
  }

  /**
   * Retry a failed build without going through planning again.
   *
   * 재시작 시나리오: orchestrator hot-reload로 고아화된 빌드, 일시적 인프라
   * 오류(Docker daemon flicker, npm install 실패 등), 유저가 판단상 "그냥 다시
   * 돌려보기"로 해결될 거라 믿을 때.
   *
   * 조건: state가 `failed` + current_session_id 유효 + 최신 handoff가 빌드 조건
   * 충족. 첫 빌드 라인만 지원 (업데이트 실패는 planning_update로 돌아가므로
   * 여기 경로를 타지 않음).
   */
  async retry(
    projectId: string,
  ): Promise<{ message: string; state: string; build_id: string; mode: BuildMode }> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');

    if (project.state !== 'failed') {
      throw new BadRequestException(
        `failed 상태에서만 재빌드할 수 있습니다. (현재: ${project.state})`,
      );
    }
    if (!project.current_session_id) {
      throw new BadRequestException('세션이 없습니다. 기획 대화부터 시작해주세요.');
    }
    const handoff = await this.handoffs.latestForSession(project.current_session_id);
    if (!handoff || !this.handoffs.isReadyForBuild(handoff)) {
      throw new BadRequestException(
        '핸드오프가 없거나 빌드 조건을 충족하지 않습니다. 기획 대화로 돌아가서 propose_handoff를 다시 호출해주세요.',
      );
    }

    // failed → plan_ready 복구 (VALID_TRANSITIONS 허용).
    await this.stateMachine.transition(projectId, 'plan_ready', 'retry from failed');
    // 이후 start()가 plan_ready → building 전이 + 스폰.
    return this.start(projectId);
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

    // 연속 실패 횟수 — 프론트가 retry 배너 primary/secondary 순서 결정에 사용.
    const consecutive_failures = await this.builds.getConsecutiveFailureCount(
      projectId,
    );

    return {
      active,
      state: project.state,
      consecutive_failures,
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

      // ADR 0008 / PRD §10.1 — QA phase 진입 시 state를 qa / update_qa로 전이해
      // UI가 "검증 중" / "회귀 검증 중" 배지를 띄울 수 있게 한다. 이전에는 building /
      // updating → 바로 env_qa로 건너뛰어 qa·update_qa 배지가 죽은 상태였음.
      if (phaseName === 'qa') {
        const mode = this.modes.get(projectId) ?? 'build';
        const qaState = mode === 'update' ? 'update_qa' : 'qa';
        void this.stateMachine
          .transition(projectId, qaState, `${mode} QA phase started`)
          .catch((err) =>
            this.logger.warn(
              `transition to ${qaState} failed: ${(err as Error).message}`,
            ),
          );
      }
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
      // QA phase success면 primary_endpoints 수집 (env-deploy가 version 저장 시 사용).
      if (phaseName === 'qa' && p['ok'] === true) {
        const endpoints = Array.isArray(p['primary_endpoints'])
          ? (p['primary_endpoints'] as unknown[])
              .filter((x) => typeof x === 'string')
              .map((x) => x as string)
          : [];
        this.primaryEndpoints.set(projectId, endpoints);
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

    // bounce 이유로 쓸 gap_list 누적. 중복 제거 (동일 phase의 phase_end와
    // error 이벤트가 같은 gap을 싣는 경우가 있어 배너에 같은 줄이 두 번
    // 보이는 버그를 차단).
    //   - error 이벤트의 payload.gap_list (phase_failure / qa_failure 등)
    //   - phase_end 이벤트의 payload.gap_list (QA path)
    if (et === 'error' || et === 'phase_end') {
      const gapList = Array.isArray(p['gap_list'])
        ? (p['gap_list'] as unknown[]).map((x) => String(x))
        : [];
      if (gapList.length) {
        const bucket = this.bounceGaps.get(projectId) ?? [];
        const existing = new Set(bucket);
        for (const g of gapList) {
          if (!existing.has(g)) {
            bucket.push(g);
            existing.add(g);
          }
        }
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
    const mode = this.modes.get(projectId) ?? 'build';
    this.modes.delete(projectId);

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
        // provider-key violation 등 — schema 자체가 잘못됐으므로 반송.
        // 첫 빌드 라인은 planning, 업데이트 라인은 planning_update로.
        this.logger.warn(
          `env sync failed for ${projectId}: ${err?.message ?? err}`,
        );
        const bounceTo = mode === 'update' ? 'planning_update' : 'planning';
        try {
          await this.stateMachine.transition(
            projectId,
            bounceTo,
            `env sync bounce: ${err?.message ?? 'unknown'}`,
          );
        } catch {
          /* ignore */
        }
        // update 라인: schema 레벨 실패는 previous로 복구 시도.
        // (컨테이너는 살아있으므로 별도 재기동 불필요)
        this.gateway.emit({
          agent: 'building',
          project_id: projectId,
          event_type: 'error',
          payload: {
            kind: 'env_schema_violation',
            message: err?.message ?? 'env 스키마가 잘못됐어요.',
            mode,
          },
        });
        return;
      }

      // Proceed to deploy — mock-first: user-required 유무와 무관.
      try {
        await this.stateMachine.transition(
          projectId,
          'env_qa',
          mode === 'update' ? 'update deploy' : 'mock-first deploy',
        );
      } catch {
        /* ignore — 이미 env_qa였을 수도 있음 */
      }
      const endpoints = this.primaryEndpoints.get(projectId);
      this.primaryEndpoints.delete(projectId);
      await this.envDeploy.applyAndDeploy(projectId, endpoints ?? null);
    } else if (code === 2) {
      // Phase 실패 exit. 수집한 gap_list + build_phases의 output_log를 합쳐
      // classifier로 원인 분류 → 분류에 따라 라우팅.
      const gaps = this.bounceGaps.get(projectId) ?? [];
      this.bounceGaps.delete(projectId);

      // phase 로그까지 긁어모아서 regex 매칭 대상에 포함
      let phaseLogs = '';
      try {
        const phases = await this.builds.getPhasesForBuild(buildId);
        phaseLogs = phases
          .map((p) => p.output_log ?? '')
          .filter(Boolean)
          .join('\n---\n');
      } catch {
        /* ignore */
      }
      const classificationInput = [gaps.join('\n'), phaseLogs]
        .filter(Boolean)
        .join('\n');
      const verdict = this.classifier.classify(classificationInput);
      this.logger.log(
        `bounce classifier for ${projectId}: ${verdict.kind} (${verdict.matched_rule ?? 'default'}) mode=${mode}`,
      );

      // 라우팅 규칙 (ADR 0008 §D2):
      //   첫 빌드 라인:
      //     infra_error / transient → failed (운영자 or 재시도 안내)
      //     code_bug / unknown       → planning 반송
      //   업데이트 라인:
      //     infra_error / transient → previous 복구 + deployed 유지
      //     code_bug / schema_bug / unknown → planning_update 반송 + previous 복구
      const isUpdate = mode === 'update';

      if (verdict.kind === 'infra_error') {
        const operatorMsg = [
          isUpdate
            ? '시스템 인프라 문제로 업데이트가 중단됐어요. 이전 버전은 그대로 유지됩니다.'
            : '시스템 인프라 문제로 빌드가 중단됐어요. 기획을 바꿔도 해결되지 않습니다.',
          `분류: ${verdict.matched_rule ?? 'infra_error'}`,
          ...(gaps.length ? gaps : []),
          '관리자에게 문의해주세요.',
        ];
        await this.builds.closeBuild(buildId, 'failed', operatorMsg);
        if (isUpdate) {
          await this.rollbackToPrevious(projectId);
          try {
            await this.stateMachine.transition(
              projectId,
              'deployed',
              `infra_error (update kept previous): ${verdict.matched_rule ?? 'unknown'}`,
            );
          } catch {
            /* ignore */
          }
        } else {
          // 첫 빌드 라인 infra_error: 좀비 컨테이너 정리 (회고 §7.5).
          await this.cleanupFailedContainer(projectId);
          try {
            await this.stateMachine.transition(
              projectId,
              'failed',
              `infra_error: ${verdict.matched_rule ?? 'unknown'}`,
            );
          } catch {
            /* ignore */
          }
        }
        this.gateway.emit({
          agent: 'building',
          project_id: projectId,
          event_type: 'error',
          payload: {
            kind: 'infra_failure',
            classifier: verdict.kind,
            matched_rule: verdict.matched_rule,
            message: operatorMsg[0],
            gap_list: operatorMsg,
            mode,
          },
        });
        return;
      }

      if (verdict.kind === 'transient') {
        const msg = [
          isUpdate
            ? '외부 서비스 일시 장애로 업데이트가 중단됐어요. 이전 버전은 유지됩니다. 잠시 뒤 다시 시도해주세요.'
            : '외부 서비스 일시 장애로 빌드가 중단됐어요. 잠시 뒤 다시 시도해주세요.',
          ...(gaps.length ? gaps : []),
        ];
        await this.builds.closeBuild(buildId, 'failed', msg);
        if (isUpdate) {
          await this.rollbackToPrevious(projectId);
          try {
            await this.stateMachine.transition(
              projectId,
              'deployed',
              `transient (update kept previous): ${verdict.matched_rule ?? 'unknown'}`,
            );
          } catch {
            /* ignore */
          }
        } else {
          // 첫 빌드 라인 transient: 좀비 컨테이너 정리 (회고 §7.5).
          await this.cleanupFailedContainer(projectId);
          try {
            await this.stateMachine.transition(
              projectId,
              'failed',
              `transient: ${verdict.matched_rule ?? 'unknown'}`,
            );
          } catch {
            /* ignore */
          }
        }
        this.gateway.emit({
          agent: 'building',
          project_id: projectId,
          event_type: 'error',
          payload: {
            kind: 'transient_failure',
            classifier: verdict.kind,
            matched_rule: verdict.matched_rule,
            message: msg[0],
            gap_list: msg,
            mode,
          },
        });
        return;
      }

      // code_bug / unknown:
      //   첫 빌드 라인: 이전에는 자동 planning 반송이었지만 — Claude Code
      //   실행이 확률적이라 같은 PRD로 재빌드하면 풀리는 경우가 많음. 그래서
      //   상태를 **failed**로 두고 유저가 UI에서 "다시 빌드" vs "기획 대화로"를
      //   **명시적으로 선택**하게 한다 (/build/retry 엔드포인트).
      //   2회 연속 실패하면 프론트 배너가 primary CTA를 "기획 대화로"로 뒤집음.
      //
      //   업데이트 라인: 여전히 planning_update 반송 + previous 복구. 업데이트는
      //   이미 배포 버전이 살아있고 대화로 수정하는 흐름이 자연스러우므로.
      await this.builds.closeBuild(
        buildId,
        isUpdate ? 'bounced' : 'failed',
        gaps.length
          ? gaps
          : ['빌드가 실패했습니다. 상세 사유가 기록되지 않았습니다.'],
      );
      if (isUpdate) {
        await this.rollbackToPrevious(projectId);
        try {
          await this.stateMachine.transition(
            projectId,
            'planning_update',
            `bounce-back: ${verdict.kind} mode=update`,
          );
        } catch {
          /* ignore */
        }
      } else {
        // 첫 빌드 라인 code_bug/unknown: 좀비 컨테이너 정리 (회고 §7.5).
        await this.cleanupFailedContainer(projectId);
        try {
          await this.stateMachine.transition(
            projectId,
            'failed',
            `code_bug/unknown (retry-first): ${verdict.kind}`,
          );
        } catch {
          /* ignore */
        }
      }
      this.gateway.emit({
        agent: 'building',
        project_id: projectId,
        event_type: 'progress',
        phase: isUpdate ? 'bounce_back' : 'build_failed_retryable',
        payload: {
          detail: isUpdate
            ? '업데이트 실패 — 대화로 돌아가 보강해주세요. 이전 버전은 유지됩니다.'
            : '빌드 실패 — 같은 기획으로 다시 시도하거나 대화로 보강할 수 있어요.',
          classifier: verdict.kind,
          matched_rule: verdict.matched_rule,
          gap_list: gaps,
          mode,
          retryable: !isUpdate,
        },
      });
    } else {
      // Unrecoverable failure. 업데이트 라인이면 previous 복구 시도.
      this.bounceGaps.delete(projectId);
      const isUpdate = mode === 'update';
      await this.builds.closeBuild(buildId, 'failed', [
        isUpdate
          ? `업데이트 에이전트가 비정상 종료했습니다 (exit code ${code}). 이전 버전은 유지됩니다.`
          : `Building Agent가 비정상 종료했습니다 (exit code ${code})`,
        '빌드 로그를 확인하고, 기획 문서에 누락된 정보가 있다면 보완해주세요.',
      ]);
      if (isUpdate) {
        await this.rollbackToPrevious(projectId);
        try {
          await this.stateMachine.transition(
            projectId,
            'deployed',
            `exit code ${code} (update kept previous)`,
          );
        } catch {
          /* ignore */
        }
      } else {
        // 첫 빌드 라인 unrecoverable: 좀비 컨테이너 정리 (회고 §7.5).
        await this.cleanupFailedContainer(projectId);
        try {
          await this.stateMachine.transition(projectId, 'failed', `exit code ${code}`);
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * ADR 0008 §D4 — update 실패 시 previous_container_id/previous_version으로
   * 프로젝트 행을 복구하고 백업 필드를 clear. 컨테이너 자체는 이미 살아있으므로
   * (update 경로는 새 컨테이너를 만들기 전에 phase 단계에서 실패) DB만 되돌리면 충분.
   *
   * env-deploy에서 이미 컨테이너를 recreate한 뒤 실패한 경우는 env-deploy 내부에서
   * 별도로 복구하므로 여기선 DB만 건드린다.
   */
  private async rollbackToPrevious(projectId: string): Promise<void> {
    const proj = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!proj) return;
    if (!proj.previous_container_id || proj.previous_version === null) {
      this.logger.warn(
        `rollbackToPrevious: previous_* not set for ${projectId}; skipping DB rollback`,
      );
      return;
    }
    await this.projectRepo.update(projectId, {
      container_id: proj.previous_container_id,
      current_version: proj.previous_version,
      previous_container_id: null,
      previous_version: null,
    });
    this.logger.log(
      `rolled back project ${projectId} to version ${proj.previous_version}`,
    );
  }

  /**
   * 회고 §7.5 후속 — 빌드 실패·취소·고아로 `failed`가 될 때 좀비 컨테이너를
   * 예방한다. projects.container_id가 있으면 `docker rm -f` 실행 후 필드 clear.
   *
   * **호출 조건 (중요)**: 첫 빌드 라인에서 failure로 빠지는 경로에서만 호출.
   * 업데이트 라인은 previous 컨테이너가 **살아있어야** 하는 불변식(ADR 0008
   * §D4)이므로 여기 로직 밖. update 쪽은 rollbackToPrevious()로 별도 처리.
   *
   * idempotent: container_id 없거나 이미 제거된 경우도 안전하게 no-op.
   * remove 실패는 warn 로그만 — Docker daemon 다운 등 운영자 상황일 뿐
   * 반환 흐름은 계속 진행. (DB 필드는 어쨌든 clear해서 port-allocator의
   * 좀비 방어 쿼리에서 벗어나게 한다.)
   */
  private async cleanupFailedContainer(projectId: string): Promise<void> {
    const proj = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!proj) return;
    if (!proj.container_id) return; // 정리할 컨테이너 없음

    try {
      await this.docker.removeContainer(proj.container_id);
      this.logger.log(
        `cleanupFailedContainer: removed ${proj.container_id.slice(0, 12)} for project ${projectId}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `cleanupFailedContainer: docker rm 실패 (${proj.container_id.slice(0, 12)}): ${err?.message ?? err} — DB 필드는 clear 진행`,
      );
    }

    // port-allocator가 이 row를 "점유 중"으로 판단하지 않도록 필드 비움.
    await this.projectRepo.update(projectId, {
      container_id: null,
      port: null,
    });
  }
}
