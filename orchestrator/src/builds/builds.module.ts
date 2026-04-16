import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Build } from './entities/build.entity.js';
import { BuildPhase } from './entities/build-phase.entity.js';
import { ProjectVersion } from './entities/project-version.entity.js';
import { AgentLog } from './entities/agent-log.entity.js';
import { BuildsService } from './builds.service.js';

/**
 * Build persistence module: records of every run, phase, deploy, and agent event.
 * Distinct from `build/` (HTTP surface) and `agents/` (process lifecycle).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Build, BuildPhase, ProjectVersion, AgentLog]),
  ],
  providers: [BuildsService],
  exports: [BuildsService],
})
export class BuildsModule {}
