import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Project } from './entities/project.entity.js';
import { ProjectPermission } from './entities/project-permission.entity.js';
import { User } from '../auth/entities/user.entity.js';

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

  /** Projects the user has any role on (owner/editor/viewer). */
  async findAllForUser(userId: string) {
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
   */
  async findPublicList(userId: string) {
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

  async findOne(id: string): Promise<Project & { failure_reason?: string[] | null }> {
    const project = await this.projectRepo.findOne({
      where: { id },
      relations: ['owner'],
    });
    if (!project) {
      throw new NotFoundException('프로젝트를 찾을 수 없습니다.');
    }

    // Include failure reason from the most recent failed build if state=failed.
    let failure_reason: string[] | null = null;
    if (project.state === 'failed') {
      const failed = await this.dataSource
        .getRepository('Build')
        .createQueryBuilder('b')
        .where('b.project_id = :pid', { pid: id })
        .andWhere("b.status IN ('failed', 'bounced')")
        .orderBy('b.finished_at', 'DESC')
        .limit(1)
        .getRawOne();
      if (failed?.b_bounce_reason_gap_list) {
        try {
          failure_reason = JSON.parse(failed.b_bounce_reason_gap_list);
        } catch {
          failure_reason = [String(failed.b_bounce_reason_gap_list)];
        }
      }
    }

    return { ...project, failure_reason };
  }

  async getUserRole(
    projectId: string,
    userId: string,
  ): Promise<string | null> {
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
      await manager.delete(ProjectPermission, { project_id: id });
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
}
