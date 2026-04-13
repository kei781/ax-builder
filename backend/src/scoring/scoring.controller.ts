import { Controller, Post, Get, Param, Body, Query, Req, UseGuards, Res } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ScoringService } from './scoring.service.js';
import type { ConversationType } from '../projects/entities/conversation.entity.js';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ScoringController {
  constructor(private readonly scoringService: ScoringService) {}

  @Get(':id/chat/history')
  async getHistory(
    @Param('id') projectId: string,
    @Query('type') type: ConversationType = 'scoring',
    @Req() req: Record<string, any>,
  ) {
    const user = req['user'] as { id: string; email: string };
    return this.scoringService.getHistory(projectId, user.id, type);
  }

  @Post(':id/chat')
  async chat(
    @Param('id') projectId: string,
    @Req() req: Record<string, any>,
    @Body() body: { message: string; type: 'scoring' | 'bug_report' | 'improvement' },
  ) {
    const user = req['user'] as { id: string; email: string };
    return this.scoringService.chat(
      projectId,
      user.id,
      body.message,
      body.type,
    );
  }

  @Post(':id/regenerate-prd')
  async regeneratePrd(
    @Param('id') projectId: string,
    @Req() req: Record<string, any>,
  ) {
    const user = req['user'] as { id: string; email: string };
    return this.scoringService.regeneratePrd(projectId, user.id);
  }

  @Post(':id/prototype')
  async generatePrototype(@Param('id') projectId: string) {
    return this.scoringService.generatePrototype(projectId);
  }

  @Get(':id/prototype')
  async getPrototype(
    @Param('id') projectId: string,
    @Res() res: Response,
  ) {
    const html = await this.scoringService.getPrototype(projectId);
    if (!html) {
      res.status(404).json({ message: 'Prototype not generated yet' });
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }
}
