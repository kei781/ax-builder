import { Injectable, NotImplementedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Session } from './entities/session.entity.js';
import { ConversationMessage } from './entities/conversation-message.entity.js';
import { SessionSummary } from './entities/session-summary.entity.js';

/**
 * Session-level operations.
 * Full implementation lands in Step 3 (Planning Agent memory).
 */
@Injectable()
export class SessionsService {
  constructor(
    @InjectRepository(Session)
    private readonly sessionRepo: Repository<Session>,
    @InjectRepository(ConversationMessage)
    private readonly messageRepo: Repository<ConversationMessage>,
    @InjectRepository(SessionSummary)
    private readonly summaryRepo: Repository<SessionSummary>,
  ) {}

  async createForProject(_projectId: string): Promise<Session> {
    throw new NotImplementedException('Sessions land in Step 3.');
  }

  async appendMessage(
    _sessionId: string,
    _partial: Partial<ConversationMessage>,
  ): Promise<ConversationMessage> {
    throw new NotImplementedException('Sessions land in Step 3.');
  }

  async findActiveForProject(_projectId: string): Promise<Session | null> {
    throw new NotImplementedException('Sessions land in Step 3.');
  }
}
