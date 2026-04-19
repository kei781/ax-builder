import {
  Controller,
  Post,
  Req,
  Res,
  Body,
  Headers,
  Logger,
  HttpCode,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AiGatewayService } from './ai-gateway.service.js';

/**
 * ADR 0003 MVP. Exposed under `/api/ai/v1/*` so the public prefix is
 * `/api/ai/v1` — generated apps set `AX_AI_BASE_URL=http://<host>/api/ai/v1`.
 *
 * This controller is **intentionally not behind JwtAuthGuard** — it uses
 * `Authorization: Bearer axt_*` (project-scoped token) instead, verified
 * in-service. Generated apps don't have user JWTs.
 */
@Controller('ai/v1')
export class AiGatewayController {
  private readonly logger = new Logger(AiGatewayController.name);

  constructor(private readonly gateway: AiGatewayService) {}

  @Post('chat/completions')
  @HttpCode(200)
  async chatCompletions(
    @Headers('authorization') auth: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Auth: resolve project from token (throws on failure)
    const projectId = await this.gateway.resolveToken(auth);
    this.logger.log(`chat/completions from project ${projectId}`);

    const upstream = await this.gateway.forwardChatCompletion(body);

    // Propagate status + headers (filtering hop-by-hop)
    res.status(upstream.status);
    const skip = new Set([
      'content-encoding',
      'content-length',
      'transfer-encoding',
      'connection',
    ]);
    upstream.headers.forEach((value, key) => {
      if (!skip.has(key.toLowerCase())) res.setHeader(key, value);
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    // Stream the body through (works for both SSE and JSON)
    const reader = upstream.body.getReader();
    const pump = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((r) => res.once('drain', r));
        }
      }
      res.end();
    };

    req.on('close', () => {
      try {
        reader.cancel().catch(() => {});
      } catch {
        /* ignore */
      }
    });

    try {
      await pump();
    } catch (err) {
      this.logger.error(
        `stream pump failed for project ${projectId}: ${(err as Error).message}`,
      );
      if (!res.writableEnded) res.end();
    }
  }

  /** Minimal usage hint endpoint — placeholder until Phase 6.1. */
  @Post('models')
  @HttpCode(200)
  async models(
    @Headers('authorization') auth: string | undefined,
  ): Promise<{ data: Array<{ id: string; object: 'model' }> }> {
    await this.gateway.resolveToken(auth);
    return {
      data: [
        { id: 'default', object: 'model' },
        { id: 'cheap', object: 'model' },
        { id: 'reasoning', object: 'model' },
        { id: 'fast', object: 'model' },
      ],
    };
  }
}
