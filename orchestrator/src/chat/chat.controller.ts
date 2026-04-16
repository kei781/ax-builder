import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import {
  ProjectPermissionsGuard,
  RequireRoles,
} from '../permissions/permissions.guard.js';
import { ChatService } from './chat.service.js';

interface JwtUser {
  id: string;
  email: string;
}

@Controller('projects')
@UseGuards(JwtAuthGuard, ProjectPermissionsGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /** Fetch conversation history — public read (viewer OK). */
  @Get(':id/chat/history')
  async history(@Param('id') id: string, @Req() req: Record<string, any>) {
    const user = req['user'] as JwtUser;
    return this.chat.getHistory(id, user.id);
  }

  /**
   * Send a user message into the Planning Agent conversation.
   * Requires owner or editor (invited).
   */
  @Post(':id/chat/messages')
  @RequireRoles('owner', 'editor')
  async send(
    @Param('id') id: string,
    @Req() req: Record<string, any>,
    @Body() body: { content: string },
  ) {
    const user = req['user'] as JwtUser;
    if (!body?.content || typeof body.content !== 'string') {
      throw new BadRequestException('content (string) is required');
    }
    return this.chat.sendUserMessage(id, user.id, body.content);
  }
}
