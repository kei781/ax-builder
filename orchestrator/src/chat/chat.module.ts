import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { Project } from '../projects/entities/project.entity.js';
import { ProjectPermission } from '../projects/entities/project-permission.entity.js';
import { Session } from '../sessions/entities/session.entity.js';
import { ConversationMessage } from '../sessions/entities/conversation-message.entity.js';
import { AgentLog } from '../builds/entities/agent-log.entity.js';
import { Handoff } from '../handoffs/entities/handoff.entity.js';
import { User } from '../auth/entities/user.entity.js';
import { StateMachineModule } from '../state-machine/state-machine.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { WebsocketModule } from '../websocket/websocket.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectPermission,
      Session,
      ConversationMessage,
      AgentLog,
      Handoff,
      User,
    ]),
    StateMachineModule,
    AgentsModule,
    WebsocketModule,
    PermissionsModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
