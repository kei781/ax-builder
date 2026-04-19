import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes, createHash } from 'crypto';

import { Project } from '../projects/entities/project.entity.js';

/**
 * ADR 0003 MVP — AI Gateway service.
 *
 * Responsibilities:
 *   1. Issue per-project `AX_AI_TOKEN`(prefix `axt_`). Plaintext goes to
 *      project_env_vars (system-injected, encrypted). SHA-256 hash goes to
 *      projects.ai_token_hash for O(1) auth lookup.
 *   2. Authenticate incoming Bearer tokens → resolve project_id.
 *   3. Forward OpenAI-compatible chat completion requests upstream (Gemini
 *      `/v1beta/openai/chat/completions` for MVP). Streams SSE through.
 *
 * What we DON'T do yet: rate limiting, budgets, usage logging per project,
 * model routing via agent-model-mcp slots. Those are Phase 6.1+.
 */
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly upstreamBase: string;
  private readonly upstreamApiKey: string;

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    private readonly config: ConfigService,
  ) {
    this.upstreamBase = this.config
      .get<string>(
        'AI_GATEWAY_UPSTREAM_BASE_URL',
        'https://generativelanguage.googleapis.com/v1beta/openai',
      )
      .replace(/\/$/, '');
    this.upstreamApiKey =
      this.config.get<string>('AI_GATEWAY_UPSTREAM_API_KEY') ??
      this.config.get<string>('GEMINI_API_KEY') ??
      '';
    if (!this.upstreamApiKey) {
      this.logger.warn(
        'AI_GATEWAY_UPSTREAM_API_KEY / GEMINI_API_KEY not set — /chat/completions will fail.',
      );
    }
  }

  /** Generate a new plaintext token (`axt_<hex>`) and return it along with its hash. */
  mintToken(): { plaintext: string; hash: string } {
    const raw = randomBytes(24).toString('hex'); // 48 chars
    const plaintext = `axt_${raw}`;
    const hash = createHash('sha256').update(plaintext).digest('hex');
    return { plaintext, hash };
  }

  /**
   * Called by EnvsService when resolving AX_AI_TOKEN for a project.
   * Mints a new token if the project doesn't have one yet; otherwise returns
   * null (caller should reuse the existing plaintext stored in
   * project_env_vars — we do NOT store plaintext on Project, only hash).
   */
  async ensureToken(projectId: string): Promise<string | null> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) return null;
    if (project.ai_token_hash) {
      // Already minted. Caller falls back to existing AX_AI_TOKEN row value.
      return null;
    }
    const { plaintext, hash } = this.mintToken();
    await this.projectRepo.update(projectId, { ai_token_hash: hash });
    this.logger.log(`Minted AX_AI_TOKEN for project ${projectId}`);
    return plaintext;
  }

  /** Revoke a project's token. Caller clears the env var too if desired. */
  async revokeToken(projectId: string): Promise<void> {
    await this.projectRepo.update(projectId, { ai_token_hash: null });
    this.logger.log(`Revoked AX_AI_TOKEN for project ${projectId}`);
  }

  /** Resolve Bearer token → project_id. Throws Unauthorized if invalid. */
  async resolveToken(bearer: string | null | undefined): Promise<string> {
    if (!bearer) throw new UnauthorizedException('AX_AI_TOKEN 누락');
    const token = bearer.replace(/^Bearer\s+/i, '').trim();
    if (!token.startsWith('axt_')) {
      throw new UnauthorizedException('유효하지 않은 토큰 형식');
    }
    const hash = createHash('sha256').update(token).digest('hex');
    const project = await this.projectRepo.findOne({
      where: { ai_token_hash: hash },
    });
    if (!project) throw new UnauthorizedException('토큰이 존재하지 않거나 폐기됨');
    return project.id;
  }

  /**
   * Forward a chat completion request to upstream. Handles both streaming
   * (SSE) and non-streaming paths. Upstream is OpenAI-compatible so we can
   * pass the body through mostly as-is.
   *
   * Returns a Web Response that the controller pipes to the HTTP reply.
   */
  async forwardChatCompletion(body: unknown): Promise<Response> {
    if (!this.upstreamApiKey) {
      throw new InternalServerErrorException(
        'AI Gateway upstream API key not configured',
      );
    }
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('body가 필요합니다.');
    }
    const payload = this.normalizeModel(body as Record<string, unknown>);

    const upstreamUrl = `${this.upstreamBase}/chat/completions`;
    const resp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.upstreamApiKey}`,
        Accept:
          (payload as Record<string, unknown>)['stream'] === true
            ? 'text/event-stream'
            : 'application/json',
      },
      body: JSON.stringify(payload),
    });
    return resp;
  }

  /**
   * Translate logical model names (`default`, `cheap`, `reasoning`) into the
   * concrete upstream model. MVP mapping — extensible via config later.
   */
  private normalizeModel(
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    const logical = typeof body['model'] === 'string' ? (body['model'] as string) : '';
    const map: Record<string, string> = {
      default: 'gemini-2.5-flash',
      cheap: 'gemini-2.5-flash',
      reasoning: 'gemini-2.5-pro',
      fast: 'gemini-2.5-flash',
    };
    const concrete = map[logical];
    if (concrete) {
      return { ...body, model: concrete };
    }
    // Caller used a concrete model name — pass through (caller's responsibility).
    return body;
  }
}
