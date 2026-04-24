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
 * Env-driven deploy/restart orchestration (ADR 0005 + 0006 + 0008).
 *
 * Three entry modes:
 *
 * 1. **First-time deploy** (fresh, 첫 빌드 라인): BuildingRunner.handleExit이
 *    plan_ready 경유 → env_qa로 전이 후 호출. 컨테이너를 새로 생성.
 *
 * 2. **Update deploy** (fresh 유사, 업데이트 라인): BuildingRunner가 updating
 *    성공 후 env_qa로 전이. previous_container_id는 projects에 백업돼있고,
 *    새 컨테이너를 띄운다. 실패 시 `rollbackToPrevious()`로 복구.
 *
 * 3. **Maintenance restart** (container_id != null, state == 'deployed'):
 *    `POST /env apply=true` 또는 `POST /restart`. 컨테이너 recreate.
 *
 * Failure routing:
 *   - env_rejected / transient / unknown (non-code) → deployed 유지, 토스트.
 *   - code_bug → planning / planning_update (첫 빌드 / 업데이트 분기).
 *   - schema_bug (env_rejected ≥ 3 streak) → planning / planning_update.
 *   - 업데이트 라인 실패는 previous_container_id로 복구 후 deployed 유지 또는
 *     planning_update 반송 (ADR 0008 §D4 — 기존 버전이 살아있어야 한다는 불변식).
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

  async applyAndDeploy(
    projectId: string,
    primaryEndpoints: string[] | null = null,
  ): Promise<void> {
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
      await this.freshDeploy(projectId, proj, primaryEndpoints);
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

  private async freshDeploy(
    projectId: string,
    proj: Project,
    primaryEndpoints: string[] | null = null,
  ): Promise<void> {
    // 업데이트 라인 여부 판별: building.runner.start에서 previous_container_id 백업함.
    // 업데이트 모드면 기존(= previous) 컨테이너를 **건드리지 않고** 새 컨테이너를
    // 별도 포트에 띄운다. 헬스체크 성공 시에만 이전 컨테이너를 제거하고 커밋.
    const isUpdate = !!proj.previous_container_id;

    if (!isUpdate) {
      // 첫 빌드 라인: 재시도 중이라 잔여물이 있을 수 있음. 안전하게 정리.
      if (proj.container_id) {
        try {
          await this.docker.removeContainer(proj.container_id);
        } catch (err: any) {
          this.logger.warn(
            `remove previous container failed: ${err?.message ?? err}`,
          );
        }
      }
    }

    const envDict = await this.envs.resolveAllForContainer(projectId);

    // ADR 0008 §D4 + 회고 §10: update 모드는 옛 컨테이너가 살아있는 동안 새
    // 컨테이너를 띄워야 한다. Docker 컨테이너 이름은 unique 제약이 있어 같은
    // canonical 이름을 두 개 못 쓴다. 따라서 update 사이클의 새 컨테이너는
    // 임시 suffix(`update-{ts}`)로 띄우고, 헬스체크 통과 직후(아래) 옛 컨테이너
    // 제거 + 새 컨테이너 rename으로 swap.
    const nameSuffix = isUpdate ? `update-${Date.now()}` : undefined;

    let port: number;
    let containerId: string;
    try {
      port = await this.portAllocator.allocate();
      containerId = await this.docker.createContainer(
        projectId,
        proj.project_path!,
        port,
        envDict,
        nameSuffix,
      );
      await this.docker.startContainer(containerId);
    } catch (err: any) {
      this.logger.error(`container create/start failed: ${err?.message ?? err}`);
      await this.handleFailure(
        projectId,
        `container start failed: ${err?.message ?? 'unknown'}`,
        isUpdate ? 'update' : 'fresh',
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
      // 업데이트 라인: 새 컨테이너만 제거. 이전 컨테이너는 그대로 살아있음.
      // handleFailure가 이전 버전으로 DB를 복구한다.
      await this.handleFailure(projectId, logs, isUpdate ? 'update' : 'fresh');
      return;
    }

    // 성공 — 이제야 이전 컨테이너 제거 (업데이트 라인).
    // 옛 컨테이너 제거 후 임시 이름의 새 컨테이너를 canonical 이름으로 rename.
    // 회고 §10: 두 단계가 같은 try 안에 있어야 부분 실패 시 일관성 보장.
    if (isUpdate && proj.previous_container_id) {
      try {
        await this.docker.removeContainer(proj.previous_container_id);
        await this.docker.renameContainer(
          containerId,
          this.docker.canonicalName(projectId),
        );
      } catch (err: any) {
        this.logger.warn(
          `post-update swap (remove old + rename new) failed: ${err?.message ?? err}`,
        );
        // rename 실패는 치명적이지 않다 — 새 컨테이너는 임시 이름으로 살아있고
        // DB가 container_id를 정확히 가리킨다. 다음 update 사이클에서 또
        // 임시 suffix 붙여 띄우면 충돌 없다.
      }
    }

    const newVersion = (proj.current_version ?? 0) + 1;
    await this.projectRepo.update(projectId, {
      current_version: newVersion,
      port,
      container_id: containerId,
      env_attempts: 0,
      previous_container_id: null,
      previous_version: null,
    });
    await this.builds.createVersion(
      projectId,
      newVersion,
      containerId,
      primaryEndpoints,
    );

    try {
      await this.stateMachine.transition(
        projectId,
        'deployed',
        isUpdate ? 'update deploy ok' : 'fresh deploy ok',
      );
    } catch {
      /* ignore */
    }

    this.emitCompletion(projectId, port, containerId);
  }

  /**
   * env 값이 바뀌었을 때 컨테이너에 새 값이 반영되려면 **recreate**가 필요하다.
   * Docker의 Env는 createContainer 시점에 고정되므로 `docker restart`로는
   * 값이 갱신되지 않는다. 기존 컨테이너를 정리하고 새 env로 재생성한다.
   *
   * 이전 컨테이너는 같은 이름/같은 포트 매핑을 쓰므로 호스트 port는 유지된다.
   * 문제 발생 시 fresh path와 동일하게 handleFailure → deployed 유지 롤백.
   */
  private async maintenanceRestart(
    projectId: string,
    oldContainerId: string,
    port: number,
  ): Promise<void> {
    const proj = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!proj?.project_path) {
      this.logger.error(`project_path missing for ${projectId}`);
      await this.handleFailure(projectId, 'project_path missing', 'maintenance');
      return;
    }

    // 1) Remove old container (stop + rm)
    try {
      await this.docker.removeContainer(oldContainerId);
    } catch (err: any) {
      this.logger.warn(`removing old container failed: ${err?.message ?? err}`);
      // Proceed anyway — creating with same name will fail and surface the issue.
    }

    // 2) Recreate with fresh env
    const envDict = await this.envs.resolveAllForContainer(projectId);

    let newContainerId: string;
    try {
      newContainerId = await this.docker.createContainer(
        projectId,
        proj.project_path,
        port,
        envDict,
      );
      await this.docker.startContainer(newContainerId);
    } catch (err: any) {
      this.logger.error(`container recreate failed: ${err?.message ?? err}`);
      await this.handleFailure(
        projectId,
        `container recreate failed: ${err?.message ?? 'unknown'}`,
        'maintenance',
      );
      return;
    }

    // 3) Health check
    const ok = await this.pollHealth(port, 60_000);
    if (!ok) {
      this.logger.warn(
        `maintenance recreate health poll failed for ${projectId} port ${port}`,
      );
      const logs = await this.docker.getLogs(newContainerId, 500);
      // Keep new container around — user might want to inspect. We stay on
      // `deployed` via handleFailure routing (non-code failures).
      await this.handleFailure(projectId, logs, 'maintenance');
      return;
    }

    await this.projectRepo.update(projectId, {
      env_attempts: 0,
      container_id: newContainerId,
    });
    try {
      await this.stateMachine.transition(projectId, 'deployed', 'maintenance recreate ok');
    } catch {
      /* ignore */
    }
    this.emitCompletion(projectId, port, newContainerId);
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
   * 라우팅 규칙 (ADR 0005 + 0008):
   *
   * 첫 빌드 라인 (fresh):
   *   env_rejected + attempts < 3 → failed, 토스트
   *   env_rejected + attempts ≥ 3 → schema_bug → planning
   *   transient → failed, 토스트
   *   code_bug / unknown → planning
   *
   * 업데이트 라인 (update):
   *   env_rejected + attempts < 3 → deployed (이전 유지), 토스트 "값 재입력"
   *   env_rejected + attempts ≥ 3 → schema_bug → planning_update (이전 유지)
   *   transient → deployed (이전 유지), 토스트
   *   code_bug / unknown → planning_update (이전 유지)
   *
   * 유지보수 라인 (maintenance):
   *   모든 실패 → deployed 유지 (ADR 0006 rollback-for-free)
   *   단 code_bug는 planning_update (대화 수정 세션)
   *
   * 업데이트/유지보수 라인에서 컨테이너는 previous로 복구되거나 기존 그대로 유지.
   */
  private async handleFailure(
    projectId: string,
    containerLogs: string,
    mode: 'fresh' | 'update' | 'maintenance',
  ): Promise<void> {
    const proj = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!proj) return;

    const verdict = this.classifier.classify(containerLogs);
    this.logger.log(
      `env_qa classifier verdict for ${projectId}: ${verdict.kind} (${verdict.matched_rule ?? 'default'}) mode=${mode}`,
    );

    let nextState: 'deployed' | 'planning' | 'planning_update' | 'failed' = 'deployed';
    let effectiveKind: FailureKindEffective = verdict.kind;
    let userMessage: string;

    // 반송 목적지: 첫 빌드는 planning, 그 외(update/maintenance)는 planning_update.
    const bounceTarget: 'planning' | 'planning_update' =
      mode === 'fresh' ? 'planning' : 'planning_update';

    if (verdict.kind === 'env_rejected') {
      const nextAttempts = (proj.env_attempts ?? 0) + 1;
      await this.projectRepo.update(projectId, { env_attempts: nextAttempts });
      if (nextAttempts >= MAX_ENV_ATTEMPTS) {
        effectiveKind = 'schema_bug';
        nextState = bounceTarget;
        userMessage = `같은 항목에서 ${MAX_ENV_ATTEMPTS}회 연속 거부됐어요. ${
          mode === 'fresh' ? '기획' : '대화'
        }부터 다시 점검합니다.`;
      } else {
        nextState = mode === 'fresh' ? 'failed' : 'deployed';
        userMessage = '입력하신 값이 거부됐어요. 확인 후 다시 입력해주세요.';
      }
    } else if (verdict.kind === 'transient') {
      nextState = mode === 'fresh' ? 'failed' : 'deployed';
      userMessage =
        '연결한 외부 서비스에서 응답이 없어요. 잠시 뒤 다시 시도해주세요.';
    } else if (verdict.kind === 'code_bug') {
      nextState = bounceTarget;
      userMessage =
        mode === 'fresh'
          ? '앱 코드에 문제가 있어 기획을 다시 다듬어야 해요.'
          : '앱 코드에 문제가 있어요. 대화로 수정해보세요. 이전 버전은 유지됩니다.';
    } else {
      // unknown → 안전하게 code_bug로 폴백
      nextState = bounceTarget;
      userMessage = '원인을 특정하지 못했어요. 세부 내용을 확인해주세요.';
    }

    // update 라인: previous 컨테이너로 DB 복구 (container_id/version 되돌리기).
    // deployed 유지든 planning_update 반송이든, 이전 버전이 살아있어야 한다는
    // 불변식은 동일. 컨테이너 자체는 freshDeploy에서 이미 제거됨.
    if (mode === 'update' && proj.previous_container_id) {
      await this.projectRepo.update(projectId, {
        container_id: proj.previous_container_id,
        current_version: proj.previous_version ?? proj.current_version,
        previous_container_id: null,
        previous_version: null,
      });
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
