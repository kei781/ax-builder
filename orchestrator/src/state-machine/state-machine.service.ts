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
 * The flow is intentionally restrictive — requesting a transition that
 * is not listed here throws, preventing accidental skips (e.g. jumping
 * draft → building without a Planning session).
 */
/**
 * ADR 0005 mock-first + ADR 0006 maintenance.
 *
 * Key: `deployed` is the default terminal state after build — env handling
 * happens as side-transitions. `deployed → deployed` self-loop exists
 * implicitly (DB-only env saves don't transition); `deployed → env_qa`
 * covers maintenance restart. `env_qa` can return to `deployed` on any
 * non-code failure (rollback-for-free).
 */
const VALID_TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  draft: ['planning'],
  planning: ['plan_ready', 'failed'],
  plan_ready: ['building', 'planning'],
  building: ['qa', 'awaiting_env', 'deployed', 'planning', 'failed'],
  qa: ['awaiting_env', 'env_qa', 'deployed', 'planning', 'failed'],
  awaiting_env: ['env_qa', 'planning', 'failed'], // legacy (ADR 0005 이후 거의 미사용)
  env_qa: ['deployed', 'awaiting_env', 'modifying', 'planning', 'failed'],
  deployed: ['env_qa', 'modifying', 'failed'],
  modifying: ['planning', 'plan_ready', 'building', 'deployed'],
  failed: ['planning', 'draft'],
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
