import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Project } from '../projects/entities/project.entity.js';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PortAllocatorService {
  private readonly portStart: number;
  private readonly portEnd: number;

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
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
    const activeProjects = await this.projectRepo.find({
      where: {
        status: In(['building', 'qa', 'deployed', 'awaiting_env']),
      },
      select: ['port'],
    });

    const usedPorts = new Set(
      activeProjects.map((p) => p.port).filter((p): p is number => p !== null),
    );

    for (let port = this.portStart; port <= this.portEnd; port++) {
      if (!usedPorts.has(port)) {
        return port;
      }
    }

    throw new Error('사용 가능한 포트가 없습니다.');
  }
}
