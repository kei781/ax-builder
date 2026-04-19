import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import {
  ProjectPermissionsGuard,
  RequireRoles,
} from '../permissions/permissions.guard.js';
import { ProjectsService } from './projects.service.js';
import { DockerService } from '../infra/docker.service.js';
import { EnvDeployService } from '../envs/env-deploy.service.js';

interface JwtUser {
  id: string;
  email: string;
}

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly docker: DockerService,
    private readonly envDeploy: EnvDeployService,
  ) {}

  @Get()
  async findAll(@Req() req: Record<string, any>) {
    const user = req['user'] as JwtUser;
    return this.projectsService.findAllForUser(user.id);
  }

  /** Public project list (read-only to viewers per ARCHITECTURE §9.2). */
  @Get('public')
  async findPublic(@Req() req: Record<string, any>) {
    const user = req['user'] as JwtUser;
    return this.projectsService.findPublicList(user.id);
  }

  @Post()
  async create(
    @Req() req: Record<string, any>,
    @Body() body: { title: string },
  ) {
    const user = req['user'] as JwtUser;
    return this.projectsService.create(user.id, body.title);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.projectsService.findOne(id);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Record<string, any>) {
    const user = req['user'] as JwtUser;
    await this.projectsService.delete(id, user.id);
    return { success: true };
  }

  // --- Permissions ---
  @Get(':id/permissions')
  async getPermissions(
    @Param('id') id: string,
    @Req() req: Record<string, any>,
  ) {
    const user = req['user'] as JwtUser;
    return this.projectsService.getPermissions(id, user.id);
  }

  @Post(':id/permissions')
  async grantPermission(
    @Param('id') id: string,
    @Req() req: Record<string, any>,
    @Body() body: { user_email: string; role: 'editor' | 'viewer' },
  ) {
    const user = req['user'] as JwtUser;
    return this.projectsService.grantPermission(
      id,
      user.id,
      body.user_email,
      body.role,
    );
  }

  @Delete(':id/permissions/:userId')
  async revokePermission(
    @Param('id') projectId: string,
    @Param('userId') targetUserId: string,
    @Req() req: Record<string, any>,
  ) {
    const user = req['user'] as JwtUser;
    await this.projectsService.revokePermission(
      projectId,
      user.id,
      targetUserId,
    );
    return { success: true };
  }

  // --- Container lifecycle (deployed apps) ---

  @Post(':id/stop')
  @UseGuards(ProjectPermissionsGuard)
  @RequireRoles('owner', 'editor')
  async stop(@Param('id') id: string) {
    const project = await this.projectsService.findOne(id);
    if (project.container_id) {
      await this.docker.stopContainer(project.container_id);
    }
    return { message: '서비스가 중지되었습니다.' };
  }

  /**
   * ADR 0006 — 재시작은 owner만. env_qa로 상태 전이 + 헬스체크 +
   * 실패 시 classifier를 통해 deployed 유지/modifying으로 라우팅.
   */
  @Post(':id/restart')
  @UseGuards(ProjectPermissionsGuard)
  @RequireRoles('owner')
  async restart(@Param('id') id: string) {
    const project = await this.projectsService.findOne(id);
    if (!project.container_id) {
      return { accepted: false, message: '아직 배포된 컨테이너가 없습니다.' };
    }
    // Fire-and-forget — WS로 결과 전달
    this.envDeploy
      .restartOnly(id)
      .catch((err) =>
        console.error(`[restart] project ${id} failed:`, err?.message ?? err),
      );
    return { accepted: true, message: '재시작을 시작했습니다. 잠시만 기다려주세요.' };
  }
}
