import { Controller, Post, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import {
  ProjectPermissionsGuard,
  RequireRoles,
} from '../permissions/permissions.guard.js';
import { BuildingRunner } from '../agents/building.runner.js';

@Controller('projects')
@UseGuards(JwtAuthGuard, ProjectPermissionsGuard)
export class BuildController {
  constructor(private readonly runner: BuildingRunner) {}

  /** Start a build — owner or editor only. */
  @Post(':id/build')
  @RequireRoles('owner', 'editor')
  async startBuild(@Param('id') id: string) {
    return this.runner.start(id);
  }

  /** Cancel — owner or editor only. */
  @Post(':id/build/cancel')
  @RequireRoles('owner', 'editor')
  async cancelBuild(@Param('id') id: string) {
    return this.runner.cancel(id);
  }

  /** Status — anyone with auth can read. */
  @Get(':id/build/status')
  async getBuildStatus(@Param('id') id: string) {
    return this.runner.status(id);
  }
}
