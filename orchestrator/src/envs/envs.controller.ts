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
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EnvsService, EnvVarView } from './envs.service.js';
import { EnvDeployService } from './env-deploy.service.js';
import { Project } from '../projects/entities/project.entity.js';

interface SubmitEnvDto {
  vars: Array<{ key: string; value: string }>;
  /**
   * ADR 0006 — false(기본): DB만 업데이트, 컨테이너 영향 無.
   *            true: 저장 + docker restart + 헬스체크.
   * project state가 `awaiting_env`일 때만 이 플래그 무시하고 자동 apply.
   */
  apply?: boolean;
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
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
  ) {}

  /** List env vars as safe views (masked values only). system-injected ones are filtered out. */
  @Get()
  async list(@Param('id') id: string): Promise<{ vars: EnvVarView[] }> {
    const all = await this.envs.listForProject(id);
    return { vars: all.filter((v) => v.tier !== 'system-injected') };
  }

  /**
   * Submit user-* values (ADR 0006).
   *
   * - `awaiting_env` 상태: apply 플래그 무시하고 자동으로 env_qa 트리거.
   * - `deployed` 상태 (유지보수 모드):
   *     · apply=false (기본): 검증 후 DB만 저장. 200 응답.
   *     · apply=true: 저장 + docker restart + 헬스체크. 202 + WS로 결과.
   *
   * 검증 실패 시 400 + { errors: ValidationError[] }.
   */
  @Put()
  @HttpCode(200)
  async submit(
    @Param('id') id: string,
    @Body() dto: SubmitEnvDto,
  ): Promise<{ accepted: boolean; restarting: boolean }> {
    if (!dto?.vars || !Array.isArray(dto.vars)) {
      throw new BadRequestException('vars 배열이 필요합니다.');
    }

    // Save (with server-side validation; throws 400 on failure)
    await this.envs.submit(id, dto.vars);

    const project = await this.projectRepo.findOne({ where: { id } });
    if (!project) throw new BadRequestException('프로젝트를 찾을 수 없습니다.');

    const isSetupMode = project.state === 'awaiting_env';
    const shouldRestart = isSetupMode || dto.apply === true;

    if (isSetupMode && !(await this.envs.allRequiredFilled(id))) {
      throw new BadRequestException('필수 변수가 아직 채워지지 않았습니다.');
    }

    if (shouldRestart) {
      this.deploy
        .applyAndDeploy(id)
        .catch((err) =>
          this.logger.error(
            `env deploy failed for ${id}: ${err?.message ?? err}`,
          ),
        );
    }

    return { accepted: true, restarting: shouldRestart };
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
