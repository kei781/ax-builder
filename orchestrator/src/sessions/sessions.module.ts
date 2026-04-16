import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from './entities/session.entity.js';
import { ConversationMessage } from './entities/conversation-message.entity.js';
import { SessionSummary } from './entities/session-summary.entity.js';
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Session, ConversationMessage, SessionSummary]),
  ],
  providers: [SessionsService],
  exports: [SessionsService, TypeOrmModule],
})
export class SessionsModule {}
