import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ProjectsService } from './projects.service.js';

interface JwtUser {
  id: string;
  email: string;
}

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  async findAll(@Req() req: Record<string, any>) {
    const user = req['user'] as JwtUser;
    return this.projectsService.findAllForUser(user.id);
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
    await this.projectsService.revokePermission(projectId, user.id, targetUserId);
    return { success: true };
  }

  // --- Service control ---
  @Post(':id/stop')
  async stop(@Param('id') id: string, @Req() req: Record<string, any>) {
    const user = req['user'] as JwtUser;
    return this.projectsService.stopProject(id, user.id);
  }

  @Post(':id/restart')
  async restart(@Param('id') id: string, @Req() req: Record<string, any>) {
    const user = req['user'] as JwtUser;
    return this.projectsService.restartProject(id, user.id);
  }

  // --- ENV ---
  @Get(':id/env')
  async getEnv(@Param('id') id: string, @Req() req: Record<string, any>) {
    const user = req['user'] as JwtUser;
    return this.projectsService.getEnvVars(id, user.id);
  }

  @Put(':id/env')
  async setEnv(
    @Param('id') id: string,
    @Req() req: Record<string, any>,
    @Body() body: { vars: Array<{ key: string; value: string }> },
  ) {
    const user = req['user'] as JwtUser;
    return this.projectsService.setEnvVars(id, user.id, body.vars);
  }
}
