import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as path from 'path';
import { AuthModule } from './auth/auth.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { ScoringModule } from './scoring/scoring.module.js';
import { BuildModule } from './build/build.module.js';
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
        synchronize: true, // dev only
      }),
    }),
    AuthModule,
    ProjectsModule,
    ScoringModule,
    BuildModule,
    WebsocketModule,
    HealthModule,
  ],
})
export class AppModule {}
