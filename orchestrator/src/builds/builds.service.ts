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
