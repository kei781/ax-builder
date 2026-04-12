import { Controller, Post, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { BuildService } from './build.service.js';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class BuildController {
  constructor(private readonly buildService: BuildService) {}

  @Post(':id/build')
  async startBuild(@Param('id') id: string) {
    return this.buildService.startBuild(id);
  }

  @Get(':id/build/status')
  async getBuildStatus(@Param('id') id: string) {
    return this.buildService.getBuildStatus(id);
  }

  @Get(':id/build/logs')
  async getBuildLogs(@Param('id') id: string) {
    return this.buildService.getBuildLogs(id);
  }
}
