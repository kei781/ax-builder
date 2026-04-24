import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Project } from './entities/project.entity.js';
import { ProjectPermission } from './entities/project-permission.entity.js';
import { User } from '../auth/entities/user.entity.js';

/** PRD.md의 첫 `# ...` 헤더를 추출. 없으면 빈 문자열. */
function extractH1(markdown: string): string {
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (t.startsWith('# ') && !t.startsWith('## ')) {
      return t.slice(2).trim();
    }
  }
  return '';
}

/** 제목 비교용 간단 정규화 — 소문자 + 공백 압축 + 영문 기호 제거. */
function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[()\[\]{}"'`~!@#$%^&*+=|\\/<>?.,:;_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * PRD H1이 "이 프로젝트는 무엇인가"를 식별해주지 않는 일반 라벨인지.
 * 이런 H1은 mismatch 판정의 근거로 쓰기 부적합 — 본문 스캔으로 넘어간다.
 */
function isGenericPrdLabel(normH1: string): boolean {
  const GENERIC_PATTERNS = [
    /^product requirements?( document)?( prd)?$/,
    /^prd( .*)?$/,
    /^제품 요구사항( 정의)?( prd)?$/,
    /^요구사항( 정의)?$/,
    /^기획 문서$/,
    /^product spec(ification)?$/,
  ];
  return GENERIC_PATTERNS.some((re) => re.test(normH1));
}

/**
 * Project CRUD + membership.
 *
 * The service is intentionally thin — state transitions, build lifecycle,
 * and conversation history live in dedicated modules (state-machine/,
 * agents/, sessions/). This service only owns the Project row and its
 * membership rows.
 */
@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(ProjectPermission)
    private readonly permissionRepo: Repository<ProjectPermission>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  private async isAdmin(userId: string): Promise<boolean> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    return user?.is_admin === true;
  }

  /** Projects the user has any role on (owner/editor/viewer).
   *  Admin은 모든 프로젝트를 owner 권한으로 본다 (ARCHITECTURE §9.5).
   */
  async findAllForUser(userId: string) {
    if (await this.isAdmin(userId)) {
      const allProjects = await this.projectRepo.find({
        relations: ['owner'],
        order: { created_at: 'DESC' },
      });
      return allProjects.map((p) => ({
        id: p.id,
        title: p.title,
        state: p.state,
        port: p.port,
        ownerName: p.owner?.name ?? 'Unknown',
        myRole: 'owner' as const,
        locked_until: p.locked_until,
        created_at: p.created_at,
      }));
    }

    const permissions = await this.permissionRepo.find({
      where: { user_id: userId },
      relations: ['project', 'project.owner'],
    });

    return permissions
      .filter((p) => p.project)
      .map((p) => ({
        id: p.project.id,
        title: p.project.title,
        state: p.project.state,
        port: p.project.port,
        ownerName: p.project.owner?.name ?? 'Unknown',
        myRole: p.role,
        locked_until: p.project.locked_until,
        created_at: p.project.created_at,
      }));
  }

  /**
   * All projects except those the user is already a member of.
   * Per ARCHITECTURE §9.2: project listing is public to any authenticated user.
   *
   * Admin은 findAllForUser에서 이미 모든 프로젝트를 받으므로 이 엔드포인트의
   * "publicList"가 비게 된다 (의도된 동작 — admin 입장에선 모든 게 내 것).
   */
  async findPublicList(userId: string) {
    if (await this.isAdmin(userId)) return [];

    const myPerms = await this.permissionRepo.find({ where: { user_id: userId } });
    const myProjectIds = new Set(myPerms.map((p) => p.project_id));

    const allProjects = await this.projectRepo.find({
      relations: ['owner'],
      order: { created_at: 'DESC' },
    });

    return allProjects
      .filter((p) => !myProjectIds.has(p.id))
      .map((p) => ({
        id: p.id,
        title: p.title,
        state: p.state,
        port: p.port,
        ownerName: p.owner?.name ?? 'Unknown',
        myRole: 'viewer' as const,
        created_at: p.created_at,
      }));
  }

  async create(userId: string, title: string): Promise<Project> {
    const project = this.projectRepo.create({
      owner_id: userId,
      title,
      state: 'draft',
    });
    const saved = await this.projectRepo.save(project);

    const permission = this.permissionRepo.create({
      project_id: saved.id,
      user_id: userId,
      role: 'owner',
      granted_by: userId,
    });
    await this.permissionRepo.save(permission);

    return saved;
  }

  /**
   * PRD.md H1 vs project.title 일관성 점검.
   * 2026-04-24 §8 — 베키 사고: project.title "랜덤 간식 당번"이지만 AI가
   * UPDATE 모드에서 PRD를 "Todo App"으로 전면 교체해 두 값이 엇갈린 채로
   * deployed 상태로 복귀했다. 유저도 AI도 UI에선 눈치채기 어려우므로 이 경계를
   * 명시적으로 노출한다. write_prd 가드가 들어간 이후로는 새로 깨질 일은 없지만
   * 과거 사고로 이미 깨진 프로젝트가 남아있을 수 있다.
   *
   * 판정 순서:
   *   1. H1이 project.title과 substring 관계면 → 일치.
   *   2. H1이 generic 라벨(예: "제품 요구사항 정의 (PRD)", "PRD", "Product
   *      Requirements Document")이면 H1만으로 판단 불가 → 본문 전체에서
   *      title이 등장하는지 확인. 등장하면 일치.
   *   3. 그 외 → 불일치.
   */
  private async checkTitlePrdMismatch(project: Project): Promise<boolean> {
    const prdPath = path.resolve(
      process.cwd(),
      '..',
      'projects',
      project.id,
      'PRD.md',
    );
    let raw: string;
    try {
      raw = await fs.readFile(prdPath, 'utf-8');
    } catch {
      // 파일 자체가 없으면 "불일치 없음"으로 간주(아직 기획 초기 단계).
      return false;
    }

    const normTitle = normalizeForCompare(project.title);
    if (!normTitle) return false;

    const h1 = extractH1(raw);
    const normH1 = normalizeForCompare(h1);

    if (normH1) {
      // 1) 상호 포함이면 일치.
      if (normH1.includes(normTitle) || normTitle.includes(normH1)) {
        return false;
      }
      // 2) H1이 generic label이면 본문 스캔으로 fallback.
      if (!isGenericPrdLabel(normH1)) {
        // H1이 구체적인데 매칭 안 됨 → 불일치 확정.
        return true;
      }
    }

    // 본문 전체에서 title 언급 여부 확인.
    const normBody = normalizeForCompare(raw);
    return !normBody.includes(normTitle);
  }

  async findOne(
    id: string,
  ): Promise<
    Project & {
      failure_reason?: string[] | null;
      last_bounce?: {
        build_id: string;
        finished_at: string | null;
        gap_list: string[];
      } | null;
      title_prd_mismatch?: boolean;
    }
  > {
    const project = await this.projectRepo.findOne({
      where: { id },
      relations: ['owner'],
    });
    if (!project) {
      throw new NotFoundException('프로젝트를 찾을 수 없습니다.');
    }

    // `failure_reason` — state=='failed'일 때의 최종 실패 설명.
    // `last_bounce` — planning/plan_ready로 되돌아온 "반송 직후" 상황용.
    //   build_ready로 진입했지만 아직 새 빌드가 안 시작된 구간(= state
    //   in planning|plan_ready)에서, 가장 최근 bounced 빌드의 gap_list를
    //   함께 내려준다. 프론트는 state와 last_bounce를 같이 보고 배너
    //   표시 여부를 결정.
    let failure_reason: string[] | null = null;
    let last_bounce: {
      build_id: string;
      finished_at: string | null;
      gap_list: string[];
    } | null = null;

    const latest = await this.dataSource
      .getRepository('Build')
      .createQueryBuilder('b')
      .where('b.project_id = :pid', { pid: id })
      .andWhere("b.status IN ('failed', 'bounced')")
      .orderBy('b.finished_at', 'DESC')
      .limit(1)
      .getRawOne();

    const parseGaps = (raw: unknown): string[] => {
      if (!raw) return [];
      let arr: string[];
      if (typeof raw !== 'string') {
        arr = [String(raw)];
      } else {
        try {
          const v = JSON.parse(raw);
          arr = Array.isArray(v) ? v.map(String) : [String(v)];
        } catch {
          arr = [raw];
        }
      }
      // dedupe — 과거 DB row에 같은 메시지가 두 번 저장된 경우 UI 배너에서
      // 중복 표시되는 걸 방지. 저장 시점에서 이미 막긴 했지만 legacy 데이터 대비.
      return [...new Set(arr)];
    };

    if (project.state === 'failed') {
      failure_reason = parseGaps(latest?.b_bounce_reason_gap_list);
      if (failure_reason.length === 0) {
        if (!project.container_id && !project.port) {
          failure_reason = [
            '빌드 후 Docker 컨테이너 배포에 실패했습니다.',
            'Docker daemon 상태 및 node:20-slim 이미지 사용 가능 여부를 확인한 뒤 다시 시도하거나, 기획 내용을 보강해주세요.',
          ];
        } else {
          failure_reason = [
            '빌드가 실패했습니다. 상세 사유가 기록되지 않았습니다 (이전 버전에서 발생한 빌드일 수 있음).',
            '기획 내용을 다시 확인하시고, 필요하면 추가 설명을 입력한 뒤 다시 빌드해주세요.',
          ];
        }
      }
    }

    // 반송 배너용. 가장 최근 bounced 빌드가 프로젝트 현 세션과 엮여
    // 있을 때만 노출한다(= 유저가 그 빌드 이후 아직 새 빌드를 안 돌림).
    // ADR 0008 — 업데이트 라인(planning_update / update_ready)도 지원.
    const bouncableStates = new Set([
      'planning',
      'plan_ready',
      'planning_update',
      'update_ready',
    ]);
    if (
      bouncableStates.has(project.state) &&
      latest &&
      latest.b_status === 'bounced'
    ) {
      last_bounce = {
        build_id: latest.b_id,
        finished_at: latest.b_finished_at ?? null,
        gap_list: parseGaps(latest.b_bounce_reason_gap_list),
      };
    }

    const title_prd_mismatch = await this.checkTitlePrdMismatch(project);

    return Object.assign(project, {
      failure_reason,
      last_bounce,
      title_prd_mismatch,
    });
  }

  async getUserRole(
    projectId: string,
    userId: string,
  ): Promise<string | null> {
    // Admin은 실제 permission row가 없어도 owner로 간주.
    if (await this.isAdmin(userId)) return 'owner';
    const perm = await this.permissionRepo.findOne({
      where: { project_id: projectId, user_id: userId },
    });
    return perm?.role ?? null;
  }

  private async requireRole(
    projectId: string,
    userId: string,
    allowedRoles: string[],
  ) {
    const role = await this.getUserRole(projectId, userId);
    if (!role || !allowedRoles.includes(role)) {
      throw new ForbiddenException('권한이 없습니다.');
    }
    return role;
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.requireRole(id, userId, ['owner']);
    await this.dataSource.transaction(async (manager) => {
      // Collect all dependent ids first (raw SQL — simpler than entity refs)
      const sessionIds: Array<{ id: string }> = await manager.query(
        'SELECT id FROM sessions WHERE project_id = ?',
        [id],
      );
      const sids = sessionIds.map((r) => r.id);

      const buildIds: Array<{ id: string }> = await manager.query(
        'SELECT id FROM builds WHERE project_id = ?',
        [id],
      );
      const bids = buildIds.map((r) => r.id);

      // Delete in FK-safe order: children first
      if (bids.length) {
        await manager.query(
          `DELETE FROM build_phases WHERE build_id IN (${bids.map(() => '?').join(',')})`,
          bids,
        );
      }
      if (sids.length) {
        await manager.query(
          `DELETE FROM handoffs WHERE session_id IN (${sids.map(() => '?').join(',')})`,
          sids,
        );
        await manager.query(
          `DELETE FROM conversation_messages WHERE session_id IN (${sids.map(() => '?').join(',')})`,
          sids,
        );
        await manager.query(
          `DELETE FROM session_summaries WHERE session_id IN (${sids.map(() => '?').join(',')})`,
          sids,
        );
      }

      await manager.query('DELETE FROM builds WHERE project_id = ?', [id]);
      await manager.query('DELETE FROM sessions WHERE project_id = ?', [id]);
      await manager.query('DELETE FROM project_memory WHERE project_id = ?', [id]);
      await manager.query('DELETE FROM project_versions WHERE project_id = ?', [id]);
      await manager.query('DELETE FROM agent_logs WHERE project_id = ?', [id]);
      await manager.delete(ProjectPermission, { project_id: id });

      // Clear current_session_id reference before deleting project
      await manager.query(
        'UPDATE projects SET current_session_id = NULL WHERE id = ?',
        [id],
      );
      await manager.delete(Project, id);
    });
  }

  // --- Permissions ---
  async getPermissions(projectId: string, userId: string) {
    await this.requireRole(projectId, userId, ['owner']);
    return this.permissionRepo.find({
      where: { project_id: projectId },
      relations: ['user'],
    });
  }

  async grantPermission(
    projectId: string,
    grantorId: string,
    targetEmail: string,
    role: 'editor' | 'viewer',
  ) {
    await this.requireRole(projectId, grantorId, ['owner']);

    const targetUser = await this.userRepo.findOne({
      where: { email: targetEmail },
    });
    if (!targetUser) {
      throw new NotFoundException(
        '해당 이메일의 사용자를 찾을 수 없습니다. 먼저 로그인이 필요합니다.',
      );
    }

    const existing = await this.permissionRepo.findOne({
      where: { project_id: projectId, user_id: targetUser.id },
    });

    if (existing) {
      existing.role = role;
      return this.permissionRepo.save(existing);
    }

    const perm = this.permissionRepo.create({
      project_id: projectId,
      user_id: targetUser.id,
      role,
      granted_by: grantorId,
    });
    return this.permissionRepo.save(perm);
  }

  async revokePermission(
    projectId: string,
    revokerId: string,
    targetUserId: string,
  ) {
    await this.requireRole(projectId, revokerId, ['owner']);

    const perm = await this.permissionRepo.findOne({
      where: { project_id: projectId, user_id: targetUserId },
    });
    if (!perm) throw new NotFoundException('해당 권한을 찾을 수 없습니다.');
    if (perm.role === 'owner') {
      throw new ForbiddenException('소유자 권한은 제거할 수 없습니다.');
    }

    await this.permissionRepo.remove(perm);
  }

  // ─────────────────────────────────────────────────────────────
  // PRD 백업 목록 / 복원 (2026-04-24 §8 후속)
  //
  // planning-agent의 write_prd가 덮어쓰기 직전에 `PRD.md.bak.{stampZ}`로
  // 자동 스냅샷을 남긴다. 유저가 UI에서 과거 버전을 되돌릴 수 있도록
  // 두 엔드포인트를 제공.
  // ─────────────────────────────────────────────────────────────

  private projectDir(projectId: string): string {
    return path.resolve(process.cwd(), '..', 'projects', projectId);
  }

  async listPrdBackups(
    projectId: string,
    userId: string,
  ): Promise<Array<{ filename: string; timestamp: string; bytes: number }>> {
    await this.requireRole(projectId, userId, ['owner', 'editor']);
    const dir = this.projectDir(projectId);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    // PRD.md.bak.20260422T003530Z 패턴만 취합.
    const rows: Array<{ filename: string; timestamp: string; bytes: number }> =
      [];
    for (const name of entries) {
      const m = name.match(/^PRD\.md\.bak\.(\d{8}T\d{6}Z)$/);
      if (!m) continue;
      try {
        const stat = await fs.stat(path.join(dir, name));
        rows.push({ filename: name, timestamp: m[1], bytes: stat.size });
      } catch {
        // 열람 순간 파일 사라졌으면 건너뜀.
      }
    }
    // 최신 순.
    rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return rows;
  }

  async restorePrdBackup(
    projectId: string,
    userId: string,
    filename: string,
  ): Promise<{ restored_from: string; pre_restore_backup: string }> {
    await this.requireRole(projectId, userId, ['owner']);

    // 경로 조작 방어: 허용 패턴 외 거부.
    if (!/^PRD\.md\.bak\.\d{8}T\d{6}Z$/.test(filename)) {
      throw new ForbiddenException('잘못된 백업 파일명입니다.');
    }
    const dir = this.projectDir(projectId);
    const backupPath = path.join(dir, filename);
    const prdPath = path.join(dir, 'PRD.md');

    // 복원 전에 "현재 PRD"도 별도 백업 — 유저가 복원을 되돌릴 수 있도록.
    // 2026-04-24 §8: 복원 자체도 되돌릴 여지가 있어야 데이터 안전성 확보.
    const now = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+/, '');
    // now 예: "20260424T000511Z"
    const preRestoreName = `PRD.md.bak.${now}`;
    try {
      const current = await fs.readFile(prdPath, 'utf-8');
      await fs.writeFile(path.join(dir, preRestoreName), current, 'utf-8');
    } catch {
      // 현재 PRD가 아예 없는 경우 — skip(백업할 게 없음).
    }

    // 실제 복원.
    const content = await fs.readFile(backupPath, 'utf-8');
    await fs.writeFile(prdPath, content, 'utf-8');

    return {
      restored_from: filename,
      pre_restore_backup: preRestoreName,
    };
  }
}
