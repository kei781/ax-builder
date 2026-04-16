import { Module } from '@nestjs/common';
import { BuildController } from './build.controller.js';
import { AgentsModule } from '../agents/agents.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';

@Module({
  imports: [AgentsModule, ProjectsModule, PermissionsModule],
  controllers: [BuildController],
})
export class BuildModule {}
