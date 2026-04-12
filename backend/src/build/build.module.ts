import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BuildService } from './build.service.js';
import { BuildController } from './build.controller.js';
import { DockerService } from './docker.service.js';
import { PortAllocatorService } from './port-allocator.service.js';
import { BuildLog } from './entities/build-log.entity.js';
import { Project } from '../projects/entities/project.entity.js';
import { WebsocketModule } from '../websocket/websocket.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([BuildLog, Project]),
    WebsocketModule,
  ],
  controllers: [BuildController],
  providers: [BuildService, DockerService, PortAllocatorService],
  exports: [BuildService, DockerService, PortAllocatorService],
})
export class BuildModule {}
