import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as path from 'path';

import { AuthModule } from './auth/auth.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { StateMachineModule } from './state-machine/state-machine.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { HandoffsModule } from './handoffs/handoffs.module.js';
import { PermissionsModule } from './permissions/permissions.module.js';
import { MemoryModule } from './memory/memory.module.js';
import { BuildsModule } from './builds/builds.module.js';
import { EnvsModule } from './envs/envs.module.js';
import { AiGatewayModule } from './ai-gateway/ai-gateway.module.js';
import { InfraModule } from './infra/infra.module.js';
import { BuildModule } from './build/build.module.js';
import { ChatModule } from './chat/chat.module.js';
import { WebsocketModule } from './websocket/websocket.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'better-sqlite3' as const,
        database: config.get<string>(
          'DB_PATH',
          path.resolve(process.cwd(), '..', 'data', 'ax-builder.db'),
        ),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: true, // dev only — schema auto-reflects entity changes
      }),
    }),

    // Foundation
    AuthModule,
    ProjectsModule,
    PermissionsModule,

    // Agent-facing persistence
    SessionsModule,
    HandoffsModule,
    MemoryModule,
    BuildsModule,
    EnvsModule,
    AiGatewayModule,

    // Infrastructure
    InfraModule,

    // Orchestration
    StateMachineModule,
    AgentsModule,
    BuildModule,
    ChatModule,

    // Transport + ops
    WebsocketModule,
    HealthModule,
  ],
})
export class AppModule {}
