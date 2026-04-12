import { Controller, Post, Get, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
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
}
