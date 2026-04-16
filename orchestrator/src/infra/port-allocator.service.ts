import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { Project } from '../projects/entities/project.entity.js';
import { ConfigService } from '@nestjs/config';

/**
 * Allocates an available port from PROJECT_PORT_RANGE for a new deploy.
 *
 * Takes a row lock on the Project table within a transaction so that two
 * concurrent allocations cannot return the same port. This closes the
 * race condition previously documented in the ADR discussion.
 */
@Injectable()
export class PortAllocatorService {
  private readonly portStart: number;
  private readonly portEnd: number;

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    this.portStart = this.configService.get<number>(
      'PROJECT_PORT_RANGE_START',
      3000,
    );
    this.portEnd = this.configService.get<number>(
      'PROJECT_PORT_RANGE_END',
      3999,
    );
  }

  async allocate(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const activeProjects = await manager.find(Project, {
        where: {
          state: In(['building', 'qa', 'deployed', 'modifying']),
        },
        select: ['port'],
      });

      const usedPorts = new Set(
        activeProjects
          .map((p) => p.port)
          .filter((p): p is number => p !== null),
      );

      for (let port = this.portStart; port <= this.portEnd; port++) {
        if (!usedPorts.has(port)) {
          return port;
        }
      }

      throw new Error('사용 가능한 포트가 없습니다.');
    });
  }
}
