import {
  Controller,
  Get,
  Put,
  Post,
  Param,
  Body,
  UseGuards,
  HttpCode,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import {
  ProjectPermissionsGuard,
  RequireRoles,
} from '../permissions/permissions.guard.js';
import { EnvsService, EnvVarView } from './envs.service.js';
import { EnvDeployService } from './env-deploy.service.js';

interface SubmitEnvDto {
  vars: Array<{ key: string; value: string }>;
}

/**
 * Endpoints per PRD §9.3. owner/editor only — these write secrets.
 */
@Controller('projects/:id/env')
@UseGuards(JwtAuthGuard, ProjectPermissionsGuard)
@RequireRoles('owner', 'editor')
export class EnvsController {
  private readonly logger = new Logger(EnvsController.name);

  constructor(
    private readonly envs: EnvsService,
    private readonly deploy: EnvDeployService,
  ) {}

  /** List env vars as safe views (masked values only). system-injected ones are filtered out. */
  @Get()
  async list(@Param('id') id: string): Promise<{ vars: EnvVarView[] }> {
    const all = await this.envs.listForProject(id);
    return { vars: all.filter((v) => v.tier !== 'system-injected') };
  }

  /**
   * Submit user-* values. Transitions project to env_qa, writes .env,
   * (re)deploys container, polls health. Returns immediately with
   * `{ accepted: true }`; actual result streams via WebSocket.
   */
  @Put()
  @HttpCode(202)
  async submit(
    @Param('id') id: string,
    @Body() dto: SubmitEnvDto,
  ): Promise<{ accepted: true }> {
    if (!dto?.vars || !Array.isArray(dto.vars)) {
      throw new BadRequestException('vars 배열이 필요합니다.');
    }
    await this.envs.submit(id, dto.vars);
    if (!(await this.envs.allRequiredFilled(id))) {
      throw new BadRequestException('필수 변수가 아직 채워지지 않았습니다.');
    }
    // Fire-and-forget deploy. Errors surface via WebSocket/state.
    this.deploy
      .applyAndDeploy(id)
      .catch((err) =>
        this.logger.error(
          `env deploy failed for ${id}: ${err?.message ?? err}`,
        ),
      );
    return { accepted: true };
  }

  /**
   * Guide for each var. Mirrors list() but includes full guide text and
   * flags unfilled required ones for UI emphasis.
   */
  @Get('guide')
  async guide(
    @Param('id') id: string,
  ): Promise<{ vars: EnvVarView[]; any_missing_required: boolean }> {
    const all = await this.envs.listForProject(id);
    const visible = all.filter((v) => v.tier !== 'system-injected');
    const anyMissing = visible.some(
      (v) => v.tier === 'user-required' && v.required && !v.has_value,
    );
    return { vars: visible, any_missing_required: anyMissing };
  }

  /** Rollback = re-read previous version's env (future). For now, no-op 501. */
  @Post('rollback')
  async rollback(@Param('id') _id: string): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: 'rollback 미구현 (PRD §9.3 후속 작업)' };
  }
}
