import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DockerService } from './docker.service.js';
import { PortAllocatorService } from './port-allocator.service.js';
import { Project } from '../projects/entities/project.entity.js';

/**
 * Infrastructure services shared between BuildModule and AgentsModule.
 * Uses its own TypeOrmModule.forFeature([Project]) instead of importing
 * ProjectsModule to avoid circular dependency.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Project])],
  providers: [DockerService, PortAllocatorService],
  exports: [DockerService, PortAllocatorService],
})
export class InfraModule {}
