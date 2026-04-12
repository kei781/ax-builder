import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Project } from '../projects/entities/project.entity.js';
import { BuildLog } from './entities/build-log.entity.js';
import { DockerService } from './docker.service.js';
import { PortAllocatorService } from './port-allocator.service.js';
import { BuildGateway } from '../websocket/build.gateway.js';
import { v4 as uuidv4 } from 'uuid';

interface PipelineResult {
  success: boolean;
  final_response?: string;
  error?: string;
}

@Injectable()
export class BuildService {
  private readonly logger = new Logger(BuildService.name);
  private readonly projectsBase: string;

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(BuildLog)
    private readonly buildLogRepo: Repository<BuildLog>,
    private readonly dockerService: DockerService,
    private readonly portAllocator: PortAllocatorService,
    private readonly wsGateway: BuildGateway,
  ) {
    this.projectsBase = path.resolve(process.cwd(), '..', 'projects');
  }

  async startBuild(projectId: string): Promise<{ message: string }> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId },
    });

    if (!project) {
      throw new BadRequestException('프로젝트를 찾을 수 없습니다.');
    }

    if (project.score < 900) {
      throw new BadRequestException(
        '스코어가 900점 이상이어야 빌드할 수 있습니다.',
      );
    }

    if (project.status === 'building' || project.status === 'qa') {
      throw new BadRequestException('이미 빌드가 진행 중입니다.');
    }

    // 1. Create project directory
    const projectPath = path.join(this.projectsBase, projectId);
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(path.join(projectPath, 'data'), { recursive: true });

    // 2. Save PRD
    const prdPath = path.join(projectPath, 'prd.md');
    if (project.prd_content) {
      await fs.writeFile(prdPath, project.prd_content, 'utf-8');
    }

    // 3. Allocate port
    const port = await this.portAllocator.allocate();

    // 4. Update project status
    await this.projectRepo.update(projectId, {
      status: 'building',
      port,
      project_path: projectPath,
      prd_path: prdPath,
      build_attempts: project.build_attempts + 1,
    });

    // 5. Start build pipeline (async)
    this.runBuildPipeline(projectId, projectPath, port).catch((err) => {
      this.logger.error(`Build pipeline failed: ${err.message}`);
    });

    return { message: '빌드가 시작되었습니다.' };
  }

  private async runBuildPipeline(
    projectId: string,
    projectPath: string,
    port: number,
  ): Promise<void> {
    // Create build log
    const buildLog = this.buildLogRepo.create({
      id: uuidv4(),
      project_id: projectId,
      attempt: 1,
      phase: 'build',
      status: 'running',
    });
    await this.buildLogRepo.save(buildLog);

    this.wsGateway.emitProgress(projectId, {
      phase: 'setup',
      current_task: '빌드 환경 준비 중...',
      progress_percent: 5,
    });

    try {
      const result = await this.runHermesPipeline(
        projectId,
        projectPath,
        port,
      );

      if (result.success) {
        // Create Docker container and start
        try {
          const containerId = await this.dockerService.createContainer(
            projectId,
            projectPath,
            port,
          );
          await this.dockerService.startContainer(containerId);

          await this.projectRepo.update(projectId, {
            status: 'deployed',
            container_id: containerId,
          });

          this.wsGateway.emitComplete(projectId, {
            success: true,
            url: `http://localhost:${port}`,
            port,
          });
        } catch (dockerErr: any) {
          this.logger.error(`Docker error: ${dockerErr.message}`);
          await this.projectRepo.update(projectId, {
            status: 'deployed', // Code is built, just Docker failed
          });

          this.wsGateway.emitComplete(projectId, {
            success: true,
            url: `http://localhost:${port}`,
            port,
            warning: 'Docker 컨테이너 생성에 실패했습니다. 수동 실행이 필요합니다.',
          });
        }

        buildLog.status = 'success';
        buildLog.finished_at = new Date();
      } else {
        await this.projectRepo.update(projectId, { status: 'failed' });
        buildLog.status = 'failed';
        buildLog.error_message = result.error || 'Unknown error';
        buildLog.finished_at = new Date();

        this.wsGateway.emitFailed(projectId, {
          error: result.error,
          attempt: 1,
          max_attempts: 3,
        });
      }

      await this.buildLogRepo.save(buildLog);
    } catch (err: any) {
      await this.projectRepo.update(projectId, { status: 'failed' });
      buildLog.status = 'failed';
      buildLog.error_message = err.message;
      buildLog.finished_at = new Date();
      await this.buildLogRepo.save(buildLog);

      this.wsGateway.emitFailed(projectId, {
        error: err.message,
      });
    }
  }

  private runHermesPipeline(
    projectId: string,
    projectPath: string,
    port: number,
  ): Promise<PipelineResult> {
    return new Promise((resolve, reject) => {
      const bridgePath = path.resolve(
        process.cwd(),
        '..',
        'bridge',
        'hermes_pipeline.py',
      );
      const args = JSON.stringify({ project_path: projectPath, port });

      this.logger.log(`Running Hermes pipeline: ${bridgePath} '${args}'`);

      // .env의 HERMES_PYTHON_PATH 사용 (setup.sh가 자동 감지)
      const hermesPython = process.env['HERMES_PYTHON_PATH']
        || `${process.env['HOME']}/.hermes/hermes-agent/venv/bin/python3`;

      const proc = spawn(hermesPython, [bridgePath, args], {
        cwd: process.cwd(),
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          stderr += line + '\n';
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'progress') {
              this.wsGateway.emitProgress(projectId, {
                phase: parsed.phase,
                current_task: parsed.current_task,
                progress_percent: parsed.progress_percent,
              });
            }
          } catch {
            // Non-JSON stderr line — just log it
            this.logger.debug(`[hermes] ${line}`);
          }
        }
      });

      proc.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          reject(
            new Error(`Hermes pipeline exited with code ${code}: ${stderr}`),
          );
          return;
        }
        try {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } catch {
          reject(new Error(`Failed to parse pipeline output: ${stdout}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn Hermes pipeline: ${err.message}`));
      });
    });
  }

  async getBuildStatus(projectId: string) {
    const project = await this.projectRepo.findOne({
      where: { id: projectId },
    });
    const latestLog = await this.buildLogRepo.findOne({
      where: { project_id: projectId },
      order: { started_at: 'DESC' },
    });

    return {
      status: project?.status || 'unknown',
      phase: latestLog?.phase || null,
      attempt: latestLog?.attempt || 0,
      port: project?.port || null,
    };
  }

  async getBuildLogs(projectId: string) {
    return this.buildLogRepo.find({
      where: { project_id: projectId },
      order: { started_at: 'DESC' },
    });
  }
}
