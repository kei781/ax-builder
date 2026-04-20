import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Build } from './entities/build.entity.js';
import { BuildPhase } from './entities/build-phase.entity.js';
import { ProjectVersion } from './entities/project-version.entity.js';
import { AgentLog } from './entities/agent-log.entity.js';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class BuildsService {
  private readonly logger = new Logger(BuildsService.name);

  constructor(
    @InjectRepository(Build)
    private readonly buildRepo: Repository<Build>,
    @InjectRepository(BuildPhase)
    private readonly phaseRepo: Repository<BuildPhase>,
    @InjectRepository(ProjectVersion)
    private readonly versionRepo: Repository<ProjectVersion>,
    @InjectRepository(AgentLog)
    private readonly logRepo: Repository<AgentLog>,
  ) {}

  async openBuild(
    projectId: string,
    sessionId: string,
    version: number,
  ): Promise<Build> {
    const build = this.buildRepo.create({
      id: uuidv4(),
      project_id: projectId,
      session_id: sessionId,
      version,
      status: 'running',
    });
    return this.buildRepo.save(build);
  }

  async closeBuild(
    buildId: string,
    status: 'success' | 'bounced' | 'failed' | 'cancelled',
    bounceGaps?: string[],
  ): Promise<void> {
    const update: Partial<Build> = {
      status,
      finished_at: new Date(),
    };
    if (bounceGaps) {
      update.bounce_reason_gap_list = bounceGaps;
    }
    await this.buildRepo.update(buildId, update);
  }

  async recordPhase(partial: Partial<BuildPhase> & { build_id: string }): Promise<BuildPhase> {
    const phase = this.phaseRepo.create({
      id: uuidv4(),
      ...partial,
    });
    return this.phaseRepo.save(phase);
  }

  async updatePhase(
    phaseId: string,
    update: Partial<BuildPhase>,
  ): Promise<void> {
    await this.phaseRepo.update(phaseId, update);
  }

  async getLatestBuild(projectId: string): Promise<Build | null> {
    return this.buildRepo.findOne({
      where: { project_id: projectId },
      order: { started_at: 'DESC' },
    });
  }

  /**
   * 같은 세션의 가장 최근 실패(failed/bounced/cancelled) 연속 개수.
   * 성공 빌드 또는 진행 중 빌드를 만나면 스톱.
   *
   * 프론트가 "다시 빌드" vs "기획 대화로" CTA 순서를 뒤집을 기준으로 사용.
   * 2회 이상 같은 맥락에서 실패하면 재시도보다는 대화 보강이 효과적이라는 휴리스틱.
   */
  async getConsecutiveFailureCount(projectId: string): Promise<number> {
    const builds = await this.buildRepo.find({
      where: { project_id: projectId },
      order: { started_at: 'DESC' },
      take: 10,
    });
    let count = 0;
    for (const b of builds) {
      if (b.status === 'success') break;
      if (b.status === 'running') continue; // 진행 중은 세지 않음
      if (b.status === 'failed' || b.status === 'bounced' || b.status === 'cancelled') {
        count += 1;
      }
    }
    return count;
  }

  async getPhasesForBuild(buildId: string): Promise<BuildPhase[]> {
    return this.phaseRepo.find({
      where: { build_id: buildId },
      order: { idx: 'ASC' },
    });
  }

  async recordAgentEvent(
    partial: Partial<AgentLog>,
  ): Promise<AgentLog> {
    return this.logRepo.save(
      this.logRepo.create({ id: uuidv4(), ...partial }),
    );
  }

  async createVersion(
    projectId: string,
    version: number,
    containerId?: string | null,
    primaryEndpoints?: string[] | null,
  ): Promise<ProjectVersion> {
    return this.versionRepo.save(
      this.versionRepo.create({
        id: uuidv4(),
        project_id: projectId,
        version,
        container_id: containerId ?? null,
        primary_endpoints: primaryEndpoints ?? null,
      }),
    );
  }
}
