import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Project } from '../projects/entities/project.entity.js';

/**
 * Claude Code CLI를 spawn해서 고품질 PRD/DESIGN 마크다운을 생성한다.
 * Gemini 대화 요약 + 기존 PRD를 입력으로 넘긴다.
 */
export interface PrdGenStatus {
  running: boolean;
  /** 마지막 생성 실패 시 에러 메시지 (UI 노출용) */
  lastError: string | null;
  /** 마지막 성공 시각 */
  lastSuccessAt: Date | null;
}

@Injectable()
export class PrdGeneratorService {
  private readonly logger = new Logger(PrdGeneratorService.name);
  /** 동일 projectId에 대한 중복 생성 방지 */
  private readonly running = new Set<string>();
  private readonly status = new Map<string, PrdGenStatus>();

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
  ) {}

  isRunning(projectId: string): boolean {
    return this.running.has(projectId);
  }

  getStatus(projectId: string): PrdGenStatus {
    return (
      this.status.get(projectId) || {
        running: this.running.has(projectId),
        lastError: null,
        lastSuccessAt: null,
      }
    );
  }

  private setStatus(projectId: string, patch: Partial<PrdGenStatus>) {
    const prev = this.status.get(projectId) || {
      running: false,
      lastError: null,
      lastSuccessAt: null,
    };
    this.status.set(projectId, { ...prev, ...patch });
  }

  /**
   * Fire-and-forget: 백그라운드에서 Claude CLI로 PRD+DESIGN 재생성 후 Project에 저장.
   */
  async generateInBackground(
    projectId: string,
    conversation: Array<{ role: string; content: string }>,
    currentPrd: string | null,
    currentDesign: string | null,
  ): Promise<void> {
    if (this.running.has(projectId)) {
      this.logger.debug(`PRD gen already running for ${projectId}, skipping`);
      return;
    }
    this.running.add(projectId);
    this.setStatus(projectId, { running: true, lastError: null });

    try {
      const { prd, design } = await this.runHermesBridge(
        projectId,
        conversation,
        currentPrd,
        currentDesign,
      );
      if (prd || design) {
        await this.projectRepo.update(projectId, {
          ...(prd ? { prd_content: prd } : {}),
          ...(design ? { design_content: design } : {}),
        });
        this.logger.log(
          `[${projectId}] PRD/DESIGN saved: prd=${prd?.length || 0}ch, design=${design?.length || 0}ch`,
        );
        this.setStatus(projectId, {
          running: false,
          lastError: null,
          lastSuccessAt: new Date(),
        });
      } else {
        const msg = 'Claude CLI 실행은 성공했지만 PRD.md/DESIGN.md를 만들지 못했습니다. 서버 로그를 확인하세요.';
        this.logger.error(`[${projectId}] ${msg}`);
        this.setStatus(projectId, { running: false, lastError: msg });
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      this.logger.error(`[${projectId}] PRD gen failed: ${msg}`);
      this.setStatus(projectId, { running: false, lastError: msg });
    } finally {
      this.running.delete(projectId);
    }
  }

  private async runHermesBridge(
    projectId: string,
    conversation: Array<{ role: string; content: string }>,
    currentPrd: string | null,
    currentDesign: string | null,
  ): Promise<{ prd: string | null; design: string | null }> {
    // 임시 작업 디렉토리 (Hermes가 chdir해서 작업)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'axb-prd-'));

    // 입력 파일 준비
    const convText = conversation
      .map((m) => `[${m.role.toUpperCase()}]\n${m.content}`)
      .join('\n\n---\n\n');
    await fs.writeFile(path.join(workDir, 'conversation.md'), convText, 'utf-8');
    if (currentPrd) {
      await fs.writeFile(path.join(workDir, 'current_prd.md'), currentPrd, 'utf-8');
    }
    if (currentDesign) {
      await fs.writeFile(path.join(workDir, 'current_design.md'), currentDesign, 'utf-8');
    }

    // Hermes bridge 스크립트 경로 (build.service.ts와 동일 규칙)
    const bridgePath = path.resolve(process.cwd(), '..', 'bridge', 'prd_generator.py');
    const hermesPython =
      process.env['HERMES_PYTHON_PATH'] ||
      `${process.env['HOME']}/.hermes/hermes-agent/venv/bin/python3`;
    const bridgeArgs = JSON.stringify({ work_dir: workDir });

    this.logger.log(
      `[${projectId}] Spawning Hermes bridge: ${hermesPython} ${bridgePath} (workDir=${workDir})`,
    );
    const startedAt = Date.now();

    const { stdout, stderr, code } = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
    }>((resolve, reject) => {
      const proc = spawn(hermesPython, [bridgePath, bridgeArgs], {
        cwd: process.cwd(),
        env: { ...process.env },
      });

      let stdoutBuf = '';
      let stderrBuf = '';
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('Hermes bridge timed out after 240s'));
      }, 240_000);

      proc.stdout.on('data', (d: Buffer) => (stdoutBuf += d.toString()));
      proc.stderr.on('data', (d: Buffer) => {
        const text = d.toString();
        stderrBuf += text;
        // progress JSON 라인은 debug로, 나머지는 그대로 로깅
        for (const line of text.split('\n').filter(Boolean)) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'progress') {
              this.logger.debug(
                `[${projectId}] ${parsed.phase}: ${parsed.current_task} (${parsed.progress_percent}%)`,
              );
              continue;
            }
          } catch {
            /* not JSON */
          }
          this.logger.debug(`[${projectId}] hermes: ${line.slice(0, 200)}`);
        }
      });
      proc.on('close', (c) => {
        clearTimeout(timeout);
        resolve({ stdout: stdoutBuf, stderr: stderrBuf, code: c });
      });
      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    this.logger.log(
      `[${projectId}] Hermes bridge exit=${code} in ${elapsed}s`,
    );

    // bridge는 stdout 마지막에 JSON 결과 라인 1개를 출력함
    let bridgeResult: {
      success: boolean;
      has_prd?: boolean;
      has_design?: boolean;
      error?: string;
    } | null = null;
    try {
      // stdout 마지막 유효 JSON 라인 파싱
      const lines = stdout.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          bridgeResult = JSON.parse(lines[i]);
          break;
        } catch {
          /* continue */
        }
      }
    } catch {
      /* ignore */
    }

    if (!bridgeResult) {
      const debugPath = path.join(os.tmpdir(), `axb-prd-debug-${projectId}.log`);
      await fs
        .writeFile(
          debugPath,
          `CODE: ${code}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`,
          'utf-8',
        )
        .catch(() => {});
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `Hermes bridge 응답 파싱 실패. 디버그 로그: ${debugPath}. stderr: ${stderr.slice(0, 200)}`,
      );
    }

    if (!bridgeResult.success) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(bridgeResult.error || 'Hermes bridge가 실패를 반환했습니다');
    }

    // workDir에서 생성된 PRD.md, DESIGN.md 읽기
    const files: string[] = await fs.readdir(workDir).catch(() => [] as string[]);
    this.logger.log(`[${projectId}] workDir files: ${files.join(', ')}`);

    const findFile = (candidates: string[]) => {
      for (const c of candidates) {
        if (files.includes(c)) return path.join(workDir, c);
      }
      return null;
    };
    const prdFile = findFile(['PRD.md', 'prd.md', 'Prd.md']);
    const designFile = findFile(['DESIGN.md', 'design.md', 'Design.md']);

    const [prd, design] = await Promise.all([
      prdFile ? fs.readFile(prdFile, 'utf-8').catch(() => null) : Promise.resolve(null),
      designFile
        ? fs.readFile(designFile, 'utf-8').catch(() => null)
        : Promise.resolve(null),
    ]);

    // 정리
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    return { prd, design };
  }

}
