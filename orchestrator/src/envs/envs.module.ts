import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProjectEnvVar } from './entities/project-env-var.entity.js';
import { Project } from '../projects/entities/project.entity.js';
import { ProjectPermission } from '../projects/entities/project-permission.entity.js';
import { EnvsService } from './envs.service.js';
import { EnvsController } from './envs.controller.js';
import { EnvCryptoService } from './env-crypto.service.js';
import { EnvDeployService } from './env-deploy.service.js';
import { FailureClassifierService } from './failure-classifier.service.js';
import { StateMachineModule } from '../state-machine/state-machine.module.js';
import { InfraModule } from '../infra/infra.module.js';
import { BuildsModule } from '../builds/builds.module.js';
import { WebsocketModule } from '../websocket/websocket.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module.js';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([ProjectEnvVar, Project, ProjectPermission]),
    StateMachineModule,
    InfraModule,
    BuildsModule,
    WebsocketModule,
    AuthModule,
    PermissionsModule,
    AiGatewayModule,
  ],
  controllers: [EnvsController],
  providers: [
    EnvsService,
    EnvCryptoService,
    EnvDeployService,
    FailureClassifierService,
  ],
  exports: [EnvsService, EnvDeployService, FailureClassifierService],
})
export class EnvsModule {}
