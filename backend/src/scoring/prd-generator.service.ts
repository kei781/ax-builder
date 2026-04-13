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
      const { prd, design } = await this.runClaudeCli(
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

  private async runClaudeCli(
    projectId: string,
    conversation: Array<{ role: string; content: string }>,
    currentPrd: string | null,
    currentDesign: string | null,
  ): Promise<{ prd: string | null; design: string | null }> {
    // 임시 작업 디렉토리 (claude CLI는 cwd 필요)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'axb-prd-'));

    // 대화 이력 요약본을 파일로 저장 (프롬프트에 인라인 하기엔 너무 길 수 있음)
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

    const prompt = this.buildPrompt(!!currentPrd, !!currentDesign);

    const claudePath = process.env['CLAUDE_CLI_PATH'] || 'claude';
    // --permission-mode bypassPermissions: -p (print) 모드에서 Write/Edit이
    // 권한 요청 없이 바로 실행되게 함 (임시 디렉토리라 안전)
    const args = [
      '-p',
      prompt,
      '--permission-mode',
      'bypassPermissions',
      '--allowedTools',
      'Read Write Edit Bash',
      '--output-format',
      'text',
    ];

    this.logger.log(`[${projectId}] Spawning claude CLI in ${workDir} (path=${claudePath})`);
    const startedAt = Date.now();

    const { stdout, stderr, code } = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
    }>((resolve, reject) => {
      const proc = spawn(claudePath, args, {
        cwd: workDir,
        env: { ...process.env },
      });

      let stdoutBuf = '';
      let stderrBuf = '';
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('claude CLI timed out after 180s'));
      }, 180_000);

      proc.stdout.on('data', (d: Buffer) => (stdoutBuf += d.toString()));
      proc.stderr.on('data', (d: Buffer) => (stderrBuf += d.toString()));
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
      `[${projectId}] claude CLI exit=${code} in ${elapsed}s, stdout=${stdout.length}ch, stderr=${stderr.length}ch`,
    );
    if (stderr) {
      this.logger.warn(`[${projectId}] claude stderr: ${stderr.slice(0, 800)}`);
    }
    if (stdout.length < 2000) {
      this.logger.debug(`[${projectId}] claude stdout: ${stdout.slice(0, 2000)}`);
    }

    if (code !== 0) {
      // 정리 전에 에러 발생
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `claude CLI exited ${code}. stderr: ${stderr.slice(0, 300) || '(empty)'}`,
      );
    }

    // 생성된 파일 목록 로그
    const files: string[] = await fs.readdir(workDir).catch(() => [] as string[]);
    this.logger.log(`[${projectId}] workDir files: ${files.join(', ')}`);

    // 대소문자 변형 모두 허용
    const findFile = (candidates: string[]) => {
      for (const c of candidates) {
        if (files.includes(c)) return path.join(workDir, c);
      }
      return null;
    };
    const prdPath = findFile(['PRD.md', 'prd.md', 'Prd.md']);
    const designPath = findFile(['DESIGN.md', 'design.md', 'Design.md']);

    const [prd, design] = await Promise.all([
      prdPath ? fs.readFile(prdPath, 'utf-8').catch(() => null) : Promise.resolve(null),
      designPath
        ? fs.readFile(designPath, 'utf-8').catch(() => null)
        : Promise.resolve(null),
    ]);

    // 파일이 없으면 stdout에서 파싱 시도 (fallback)
    let result: { prd: string | null; design: string | null };
    if (!prd && !design) {
      this.logger.warn(
        `[${projectId}] PRD.md/DESIGN.md 파일이 생성되지 않음. stdout fallback 파싱 시도.`,
      );
      result = this.parseFromStdout(stdout);
    } else {
      result = { prd, design };
    }

    // 디버그용: stdout을 파일로 남김 (생성 실패 시 원인 확인용)
    if (!result.prd && !result.design) {
      const debugPath = path.join(os.tmpdir(), `axb-prd-debug-${projectId}.log`);
      await fs
        .writeFile(debugPath, `CODE: ${code}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`, 'utf-8')
        .catch(() => {});
      this.logger.error(`[${projectId}] 빈 결과 — 디버그 로그: ${debugPath}`);
    }

    // 정리
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    return result;
  }

  private buildPrompt(hasCurrentPrd: boolean, hasCurrentDesign: boolean): string {
    return `당신은 시니어 프로덕트 매니저이자 UI/UX 디자이너입니다.

현재 디렉토리에 있는 다음 파일들을 읽으세요:
- conversation.md: 기획자(사용자)와 AI 간의 대화 이력
${hasCurrentPrd ? '- current_prd.md: 이전에 작성한 PRD 초안 (있으면 개선해서 새로 작성)' : ''}
${hasCurrentDesign ? '- current_design.md: 이전에 작성한 DESIGN.md 초안' : ''}

대화 이력을 바탕으로 아래 두 파일을 현재 디렉토리에 **반드시 Write 툴로** 생성하세요:

## 1. PRD.md
고품질의 상세한 Product Requirements Document를 마크다운으로 작성.
필수 섹션:
- 서비스 개요 (목적, 타겟 유저, 핵심 가치 제안)
- 사용자 플로우 (Step 단위로 상세하게, 테이블/리스트 활용)
- 기능 요구사항 (FR1, FR2... 번호 매기기)
- 비기능 요구사항 (성능, 브라우저 지원, 보안)
- 기술 설계 고려사항 (상태 관리, API 이벤트, 서버 구조)

대화에서 언급된 것만 적지 말고, 맥락에 맞게 합리적 기본값을 추론해서 풍부하게 작성.
아직 논의 안 된 부분은 "[미정]"으로 표시.

## 2. DESIGN.md
AI 에이전트가 바로 UI 구현에 사용할 수 있는 디자인 시스템 문서 (https://news.hada.io/topic?id=28246 형식).
필수 섹션:
- Brand Identity (톤앤매너, 분위기)
- Color Palette (primary/secondary/accent/neutral, hex 값 포함)
- Typography (폰트 패밀리, 크기 스케일, 굵기)
- Spacing & Layout (그리드, 간격 체계)
- Components (버튼, 입력, 카드 등 주요 컴포넌트 스타일 규칙)
- Depth & Elevation (그림자, 라운딩)
- Responsive Behavior (breakpoint)
- Design Principles

대화에서 디자인 힌트가 없으면 서비스 성격에 맞게 합리적으로 제안.

## 절대 규칙
- 반드시 Write 툴로 PRD.md, DESIGN.md 파일을 생성할 것 (stdout에 출력하는 게 아님)
- 두 파일 모두 완전한 마크다운 문서여야 함 (한 줄 요약 금지)
- 한국어로 작성
- 비개발자도 이해할 수 있는 용어 사용

작업 완료 후 "PRD.md와 DESIGN.md를 생성했습니다"라고만 답하세요.`;
  }

  /**
   * Claude가 Write 툴 대신 stdout에 마크다운을 출력한 경우 파싱 (fallback).
   */
  private parseFromStdout(output: string): { prd: string | null; design: string | null } {
    const prdMatch = output.match(/(?:^|\n)#\s*PRD[^\n]*\n([\s\S]*?)(?=\n#\s*DESIGN|\n---|$)/i);
    const designMatch = output.match(/(?:^|\n)#\s*DESIGN[^\n]*\n([\s\S]*)$/i);
    return {
      prd: prdMatch ? `# PRD\n${prdMatch[1].trim()}` : null,
      design: designMatch ? `# DESIGN\n${designMatch[1].trim()}` : null,
    };
  }
}
