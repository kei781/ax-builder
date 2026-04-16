import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectMemory } from './entities/project-memory.entity.js';
import { MemoryService } from './memory.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([ProjectMemory])],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
