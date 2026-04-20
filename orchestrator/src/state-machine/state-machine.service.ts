import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Project,
  ProjectState,
} from '../projects/entities/project.entity.js';

/**
 * Valid state transitions for a Project.
 *
 * 두 라인 분리(ADR 0008):
 *   첫 빌드 라인: draft → planning → plan_ready → building → qa → env_qa → deployed
 *   업데이트 라인: deployed → planning_update → update_ready → updating → update_qa → deployed
 *
 * `deployed`는 양 라인의 수렴 지점이자 터미널. env 유지보수는 deployed↔env_qa 사이드 트립.
 * update 라인 실패는 대부분 `planning_update`로 반송(bounce) — 기존 컨테이너 유지가 핵심 불변식.
 * code_bug 분류에 따라 첫 빌드 라인은 `planning`, 업데이트 라인은 `planning_update`로 라우팅.
 */
const VALID_TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  // 첫 빌드 라인
  draft: ['planning'],
  planning: ['plan_ready', 'failed'],
  plan_ready: ['building', 'planning'],
  // building → env_qa: mock-first 해피 패스 (ADR 0005). handleExit이
  // QA 통과 직후 env_qa로 전이하며 컨테이너 기동을 시작함.
  building: ['qa', 'awaiting_env', 'env_qa', 'deployed', 'planning', 'failed'],
  qa: ['awaiting_env', 'env_qa', 'deployed', 'planning', 'failed'],

  // env 사이드 (양 라인 공유)
  awaiting_env: ['env_qa', 'planning', 'failed'], // legacy (ADR 0005 이후 거의 미사용)
  // env_qa에서 update 라인으로 되돌리는 경로: planning_update (업데이트 맥락 보존).
  env_qa: [
    'deployed',
    'awaiting_env',
    'planning',
    'planning_update',
    'failed',
  ],

  // 터미널 & 합류점
  // deployed → planning_update: 업데이트 라인 진입. env_qa 사이드 트립은 유지.
  deployed: ['env_qa', 'planning_update', 'failed'],
  failed: ['planning', 'draft', 'plan_ready'],

  // 업데이트 라인
  planning_update: ['update_ready', 'deployed', 'failed'],
  // plan_ready 유사: 수정 사양 확정. 롤백(대화 보류) 시 deployed로 즉시 복귀.
  update_ready: ['updating', 'planning_update', 'deployed'],
  // updating 실패 라우팅:
  //   code_bug / schema_bug → planning_update (이전 컨테이너 복구)
  //   infra_error / transient → deployed (실패 없던 것처럼 유지)
  updating: [
    'update_qa',
    'env_qa',
    'deployed',
    'planning_update',
    'failed',
  ],
  // update_qa: regression 실패 시 planning_update로 반송. 성공 시 deployed.
  update_qa: ['deployed', 'planning_update', 'failed'],
};

@Injectable()
export class StateMachineService {
  private readonly logger = new Logger(StateMachineService.name);

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
  ) {}

  /**
   * Transition a project to a new state atomically.
   * Throws if the transition is not permitted from the current state.
   */
  async transition(
    projectId: string,
    next: ProjectState,
    reason?: string,
  ): Promise<Project> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) {
      throw new BadRequestException('프로젝트를 찾을 수 없습니다.');
    }

    const allowed = VALID_TRANSITIONS[project.state] ?? [];
    if (!allowed.includes(next)) {
      throw new BadRequestException(
        `Invalid transition: ${project.state} → ${next}`,
      );
    }

    const prev = project.state;
    project.state = next;
    const saved = await this.projectRepo.save(project);
    this.logger.log(
      `Project ${projectId}: ${prev} → ${next}${reason ? ` (${reason})` : ''}`,
    );
    return saved;
  }

  /** Read-only check — does NOT persist. Useful for pre-flight validation. */
  canTransition(current: ProjectState, next: ProjectState): boolean {
    return (VALID_TRANSITIONS[current] ?? []).includes(next);
  }
}
