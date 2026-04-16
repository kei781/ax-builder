import { Injectable, NotImplementedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectMemory } from './entities/project-memory.entity.js';

/**
 * Backend for Planning Agent's search_memory / update_memory tools.
 * Implementation in Step 3.
 */
@Injectable()
export class MemoryService {
  constructor(
    @InjectRepository(ProjectMemory)
    private readonly memoryRepo: Repository<ProjectMemory>,
  ) {}

  async search(_projectId: string, _query: string): Promise<ProjectMemory[]> {
    throw new NotImplementedException('Memory lands in Step 3.');
  }

  async upsert(
    _projectId: string,
    _key: string,
    _value: unknown,
  ): Promise<ProjectMemory> {
    throw new NotImplementedException('Memory lands in Step 3.');
  }
}
