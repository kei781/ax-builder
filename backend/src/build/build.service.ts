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

const CLAUDE_MD_TEMPLATE = `# 프로젝트 작업 규칙 (이 파일은 claude CLI가 자동 로드합니다)

## 단일 진실 공급원 (Single Source of Truth)
- **PRD.md** — 이 프로젝트의 제품 요구사항. 모든 기능/동작의 명세.
- **DESIGN.md** — 디자인 시스템. 컬러/타이포그래피/컴포넌트 스타일 규칙.

두 파일이 **프로젝트 사양의 유일한 기준**입니다.

## 작업 시작 규칙
1. 어떤 작업이든 시작 전에 **반드시 PRD.md와 DESIGN.md를 먼저 정독**할 것.
2. 스펙에 없는 기능은 임의로 추가하지 말 것. 애매하면 PRD의 현재 상태대로.
3. PRD/DESIGN에 [미정]이 있고 그 부분을 구현해야 하면:
   - 합리적 기본값 결정 → 구현 → 해당 섹션을 실제 값으로 업데이트

## 변경 규칙 (매우 중요)
코드를 수정할 때마다 **반드시** 다음을 지킬 것:

- 기능 추가/변경/삭제 → \`PRD.md\`의 해당 섹션 (기능 요구사항, 사용자 플로우, 기술 설계) 갱신
- API 엔드포인트/스키마 변경 → \`PRD.md\`의 기술 설계 섹션 갱신
- 컬러/폰트/컴포넌트 스타일 변경 → \`DESIGN.md\`의 해당 섹션 갱신
- 레이아웃/간격/반응형 변경 → \`DESIGN.md\`의 Spacing & Layout / Responsive 갱신

**"코드만 수정하고 문서는 안 건드림"은 금지.** 항상 세트로 움직인다.

필요하면 \`.claude/skills/prd-sync\` 스킬 참조.

## 기술 스택 고정값
- SQLite (\`./data/app.db\`) — 외부 DB (MySQL, Postgres 등) 사용 금지
- Node.js/Express + 정적 프론트엔드 (public/) — 단일 포트 서비스
- npm install && npm start 로 기동
- \`.env.example\`에 필요한 환경변수를 주석과 함께 정리

## 코드 품질 가이드
- 파일 구조는 최소화. 과한 추상화/레이어링 금지.
- 에러 처리는 사용자에게 보이는 경계에서만.
- 주석은 자명하지 않은 로직에만. 자명한 코드에 주석 금지.
- 기존 패턴과 일관되게. 일관성이 "개선"보다 우선.
`;

const PRD_SYNC_SKILL_TEMPLATE = `---
name: prd-sync
description: 코드를 수정한 뒤 PRD.md/DESIGN.md를 동기화. 기능 추가·변경·삭제, API/스키마 변경, 디자인 스타일 변경 직후에 반드시 호출.
---

# prd-sync

## 언제 호출
- 새 기능을 추가한 직후
- 기존 기능을 수정·삭제한 직후
- API 라우트, DB 스키마, 데이터 흐름을 바꾼 직후
- 컬러/폰트/컴포넌트 스타일·레이아웃·반응형을 수정한 직후

## 절차

### 1. 변경 범위 파악
- 방금 수정한 파일들의 diff 요약
- 영향 받는 기능/화면 식별

### 2. PRD.md 갱신
\`Read\` → PRD.md의 다음 섹션을 찾아 필요한 만큼 \`Edit\`:
- **기능 요구사항 (FR1, FR2, ...)**: 새 기능이면 다음 번호 추가, 수정이면 기존 항목 갱신, 삭제면 해당 항목 제거
- **사용자 플로우**: Step별 흐름 반영
- **기술 설계**: API 엔드포인트, DB 스키마, 상태 관리 변경 반영

### 3. DESIGN.md 갱신 (디자인 변경이면)
\`Read\` → DESIGN.md의 해당 섹션을 \`Edit\`:
- 컬러 변경 → Color Palette
- 폰트 변경 → Typography
- 컴포넌트 수정 → Components
- 간격/그리드 → Spacing & Layout
- breakpoint/반응형 → Responsive Behavior

### 4. 일관성 체크
- PRD와 DESIGN이 서로 모순되는 곳 없는지
- [미정]이었던 항목이 결정됐는지 확인하고 실제 값으로 교체

### 5. 변경 요약 출력
"PRD: FR3 추가, 기술 설계 섹션에 /api/items POST 추가 / DESIGN: 변경 없음" 형식.

## 원칙
- **삭제**할 때 주석으로 흔적 남기지 말고 깔끔하게 제거.
- 버전 관리는 git이 하는 것. 문서 안에 "(구버전)" 같은 표시 금지.
- [미정]은 구현 완료된 항목에 남아있으면 안 됨.
- 문서와 코드가 맞지 않는 상태로 끝내지 말 것. 세트로 마무리.
`;

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

    // 2. Save PRD.md + DESIGN.md + CLAUDE.md + prd-sync skill (에이전트팀 입력)
    const prdPath = path.join(projectPath, 'PRD.md');
    if (project.prd_content) {
      await fs.writeFile(prdPath, project.prd_content, 'utf-8');
    }
    if (project.design_content) {
      await fs.writeFile(
        path.join(projectPath, 'DESIGN.md'),
        project.design_content,
        'utf-8',
      );
    }
    // CLAUDE.md: claude CLI가 cwd에서 자동 검색해 시스템 프롬프트에 포함
    await fs.writeFile(
      path.join(projectPath, 'CLAUDE.md'),
      CLAUDE_MD_TEMPLATE,
      'utf-8',
    );
    // prd-sync skill: 수정 시 PRD/DESIGN 동기화 지침
    const skillDir = path.join(projectPath, '.claude', 'skills', 'prd-sync');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      PRD_SYNC_SKILL_TEMPLATE,
      'utf-8',
    );

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
        const text = data.toString();
        stdout += text;
      });

      proc.stderr.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          stderr += line + '\n';
          // JSON progress 이벤트인지 체크
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'progress') {
              this.wsGateway.emitProgress(projectId, {
                phase: parsed.phase,
                current_task: parsed.current_task,
                progress_percent: parsed.progress_percent,
              });
              continue;
            }
          } catch {
            // JSON 아니면 일반 로그로 전송
          }
          // 모든 Hermes/Claude 로그를 프론트 로그 창으로 전송
          this.wsGateway.emitLog(projectId, line);
          this.logger.debug(`[hermes] ${line}`);
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

  /**
   * 프로젝트 디렉토리의 로컬 PRD.md/DESIGN.md/CLAUDE.md를 읽어서 반환.
   * 빌드가 진행되며 Claude가 수정한 "현재 상태"를 확인하는 용도.
   */
  async getProjectDocs(projectId: string): Promise<{
    prd: string | null;
    design: string | null;
    claude: string | null;
    project_path: string | null;
  }> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    const projectPath = project?.project_path || null;
    if (!projectPath) {
      return { prd: null, design: null, claude: null, project_path: null };
    }

    const read = (name: string) =>
      fs.readFile(path.join(projectPath, name), 'utf-8').catch(() => null);

    const [prd, design, claude] = await Promise.all([
      read('PRD.md'),
      read('DESIGN.md'),
      read('CLAUDE.md'),
    ]);
    return { prd, design, claude, project_path: projectPath };
  }
}
