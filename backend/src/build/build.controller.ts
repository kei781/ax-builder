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

  /** 프로젝트 디렉토리의 로컬 파일 조회 (PRD.md / DESIGN.md / CLAUDE.md) */
  @Get(':id/build/docs')
  async getBuildDocs(@Param('id') id: string) {
    return this.buildService.getProjectDocs(id);
  }
}
