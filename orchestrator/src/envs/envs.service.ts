import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { IsNull, Repository } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  ProjectEnvVar,
  EnvTier,
} from './entities/project-env-var.entity.js';
import {
  parseEnvExample,
  findProviderKeyViolations,
  validateValue,
  ValidationError,
} from './env-parser.js';
import { EnvCryptoService } from './env-crypto.service.js';
import { Project } from '../projects/entities/project.entity.js';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service.js';

export interface EnvVarView {
  key: string;
  tier: EnvTier;
  required: boolean;
  description: string | null;
  issuance_guide: string | null;
  example: string | null;
  /** `true` when a value is stored (for user-* tiers); system-injected always true after sync. */
  has_value: boolean;
  /** Masked preview (last 4 chars). Null when no value. Never includes the raw value. */
  masked_preview: string | null;
  /** ADR 0006 validation rules — surfaced to frontend for inline checks. */
  validation_pattern: string | null;
  min_length: number | null;
  max_length: number | null;
}

export interface SyncResult {
  total: number;
  system_injected: number;
  user_required_pending: number;
  user_required_filled: number;
  user_optional: number;
  provider_key_violations: string[];
}

@Injectable()
export class EnvsService {
  private readonly logger = new Logger(EnvsService.name);

  constructor(
    @InjectRepository(ProjectEnvVar)
    private readonly envRepo: Repository<ProjectEnvVar>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    private readonly crypto: EnvCryptoService,
    private readonly config: ConfigService,
    private readonly aiGateway: AiGatewayService,
  ) {}

  /**
   * Called by building.runner after a successful build. Reads the
   * project's .env.example, upserts rows into project_env_vars, and
   * auto-injects system-injected values.
   *
   * Returns a summary so the caller can decide: deploy directly (no
   * user-required pending) or transition to `awaiting_env`.
   *
   * Throws if provider-key violations found (build should bounce).
   */
  async syncFromExample(projectId: string): Promise<SyncResult> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project?.project_path) {
      throw new NotFoundException('프로젝트 경로를 찾을 수 없습니다.');
    }

    const examplePath = path.join(project.project_path, '.env.example');
    let content: string;
    try {
      content = await fs.readFile(examplePath, 'utf8');
    } catch {
      // No .env.example — treat as zero vars. QA pre-check already enforced
      // existence, but we're defensive.
      return {
        total: 0,
        system_injected: 0,
        user_required_pending: 0,
        user_required_filled: 0,
        user_optional: 0,
        provider_key_violations: [],
      };
    }

    const parsed = parseEnvExample(content);
    const violations = findProviderKeyViolations(parsed);
    if (violations.length) {
      throw new BadRequestException(
        `AI Gateway를 써야 하는 provider 키가 user-tier로 노출됨: ${violations.join(', ')}`,
      );
    }

    // Upsert rows. Preserve existing user values on re-sync.
    const existing = await this.envRepo.find({ where: { project_id: projectId } });
    const existingMap = new Map(existing.map((e) => [e.key, e]));

    let systemInjectedCount = 0;
    let userRequiredPending = 0;
    let userRequiredFilled = 0;
    let userOptional = 0;

    for (const v of parsed) {
      const prev = existingMap.get(v.key);
      const row =
        prev ??
        this.envRepo.create({
          project_id: projectId,
          key: v.key,
        });
      row.tier = v.tier;
      row.required = v.required;
      row.description = v.description ?? null;
      row.issuance_guide = v.issuance_guide ?? null;
      row.example = v.example ?? null;
      row.validation_pattern = v.validation_pattern ?? null;
      row.min_length = v.min_length ?? null;
      row.max_length = v.max_length ?? null;

      if (v.tier === 'system-injected') {
        // AX_AI_TOKEN: real minting, idempotent per project (ADR 0003).
        if (v.key === 'AX_AI_TOKEN') {
          const fresh = await this.aiGateway.ensureToken(projectId);
          if (fresh) {
            // First mint — store plaintext encrypted so writeDotenv can recover.
            row.value_ciphertext = this.crypto.encrypt(fresh);
          }
          // If not fresh: project already has a hash. The existing
          // value_ciphertext (from `prev`) is preserved.
        } else {
          const injected = this.resolveSystemInjected(v.key);
          if (injected != null) {
            row.value_ciphertext = this.crypto.encrypt(injected);
          }
        }
        systemInjectedCount++;
      } else if (v.tier === 'user-required') {
        if (row.value_ciphertext) userRequiredFilled++;
        else userRequiredPending++;
      } else {
        userOptional++;
      }

      await this.envRepo.save(row);
      existingMap.delete(v.key);
    }

    // Vars that vanished from .env.example — drop them
    for (const stale of existingMap.values()) {
      await this.envRepo.remove(stale);
    }

    return {
      total: parsed.length,
      system_injected: systemInjectedCount,
      user_required_pending: userRequiredPending,
      user_required_filled: userRequiredFilled,
      user_optional: userOptional,
      provider_key_violations: [],
    };
  }

  /**
   * Resolve a system-injected variable name to its value. Null = unknown
   * (or handled elsewhere — AX_AI_TOKEN goes through `aiGateway.ensureToken`).
   */
  private resolveSystemInjected(key: string): string | null {
    switch (key) {
      case 'AX_AI_BASE_URL':
        return (
          this.config.get<string>('AI_GATEWAY_BASE_URL') ??
          this.config.get<string>('AX_AI_BASE_URL') ??
          null
        );
      case 'AX_STORAGE_PATH':
        return '/app/data';
      default:
        return null;
    }
  }

  async listForProject(projectId: string): Promise<EnvVarView[]> {
    const rows = await this.envRepo.find({
      where: { project_id: projectId },
      order: { tier: 'ASC', key: 'ASC' },
    });
    return rows.map((r) => this.toView(r));
  }

  private toView(r: ProjectEnvVar): EnvVarView {
    let maskedPreview: string | null = null;
    if (r.value_ciphertext) {
      try {
        const plain = this.crypto.decrypt(r.value_ciphertext);
        maskedPreview = this.mask(plain);
      } catch {
        maskedPreview = '••••••';
      }
    }
    return {
      key: r.key,
      tier: r.tier,
      required: r.required,
      description: r.description,
      issuance_guide: r.issuance_guide,
      example: r.example,
      has_value: !!r.value_ciphertext,
      masked_preview: maskedPreview,
      validation_pattern: r.validation_pattern ?? null,
      min_length: r.min_length ?? null,
      max_length: r.max_length ?? null,
    };
  }

  private mask(value: string): string {
    if (value.length <= 4) return '•'.repeat(value.length);
    return '•'.repeat(Math.min(value.length - 4, 12)) + value.slice(-4);
  }

  /**
   * Apply a batch of user-submitted env values (ADR 0006).
   *
   * - Only `user-required` / `user-optional` tiers are writable.
   * - Each value runs through `validateValue()` — pattern / length / required.
   * - If any validation fails, throws BadRequestException with `errors[]` payload,
   *   and **no** partial writes are persisted (transactional best-effort:
   *   validate all first, write all second).
   * - `value === ''` means "clear this value" (sets ciphertext to null).
   */
  async submit(
    projectId: string,
    vars: Array<{ key: string; value: string }>,
  ): Promise<void> {
    // 1) load all target rows first
    const targets: Array<{
      value: string;
      row: ProjectEnvVar;
    }> = [];
    for (const { key, value } of vars) {
      const row = await this.envRepo.findOne({
        where: { project_id: projectId, key },
      });
      if (!row) continue; // key not in example — silently ignore
      if (row.tier === 'system-injected') continue; // protected
      targets.push({ value: value ?? '', row });
    }

    // 2) validate
    const errors: ValidationError[] = [];
    for (const { value, row } of targets) {
      const err = validateValue(row.key, value, {
        required: row.required && row.tier === 'user-required',
        validation_pattern: row.validation_pattern,
        min_length: row.min_length,
        max_length: row.max_length,
        example: row.example,
      });
      if (err) errors.push(err);
    }
    if (errors.length) {
      throw new BadRequestException({
        message: '환경변수 검증 실패',
        errors,
      });
    }

    // 3) persist
    for (const { value, row } of targets) {
      row.value_ciphertext = value ? this.crypto.encrypt(value) : null;
      await this.envRepo.save(row);
    }
  }

  /** Returns true if all user-required vars have values stored. */
  async allRequiredFilled(projectId: string): Promise<boolean> {
    const missing = await this.envRepo.count({
      where: {
        project_id: projectId,
        tier: 'user-required',
        required: true,
        value_ciphertext: IsNull(),
      },
    });
    return missing === 0;
  }

  /**
   * Write the resolved `.env` file to the project directory. Called
   * before container (re)creation.
   */
  async writeDotenv(projectId: string): Promise<void> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project?.project_path) {
      throw new NotFoundException('프로젝트 경로 없음');
    }
    const rows = await this.envRepo.find({ where: { project_id: projectId } });
    const lines: string[] = [
      '# Auto-generated by ax-builder. Do not edit by hand — values are',
      '# sourced from project_env_vars (encrypted at rest).',
      '',
    ];
    for (const r of rows) {
      if (!r.value_ciphertext) continue;
      const plain = this.crypto.decrypt(r.value_ciphertext);
      // Escape special chars minimally — we write bash-compatible KEY="value"
      // with \" and \$ escaped inside.
      const escaped = plain.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      lines.push(`${r.key}="${escaped}"`);
    }
    const dest = path.join(project.project_path, '.env');
    await fs.writeFile(dest, lines.join('\n'), { mode: 0o600 });
    this.logger.log(`Wrote .env for project ${projectId} (${rows.length} vars)`);
  }

  /**
   * Return all resolved env values (decrypted) as a key→value dict.
   * Used to pass as Docker container Env at create time, so the app
   * process sees them in process.env without needing `dotenv`.
   */
  async resolveAllForContainer(projectId: string): Promise<Record<string, string>> {
    const rows = await this.envRepo.find({ where: { project_id: projectId } });
    const dict: Record<string, string> = {};
    for (const r of rows) {
      if (!r.value_ciphertext) continue;
      try {
        dict[r.key] = this.crypto.decrypt(r.value_ciphertext);
      } catch (err: any) {
        this.logger.warn(
          `resolveAllForContainer: decrypt failed for ${r.key}: ${err?.message ?? err}`,
        );
      }
    }
    return dict;
  }

  async hasUserRequired(projectId: string): Promise<boolean> {
    const c = await this.envRepo.count({
      where: {
        project_id: projectId,
        tier: 'user-required',
        required: true,
      },
    });
    return c > 0;
  }
}
