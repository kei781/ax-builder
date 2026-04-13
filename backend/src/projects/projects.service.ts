import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Project } from './entities/project.entity.js';
import { ProjectPermission } from './entities/project-permission.entity.js';
import { ProjectEnvVar } from './entities/project-env-var.entity.js';
import { Conversation } from './entities/conversation.entity.js';
import { User } from '../auth/entities/user.entity.js';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(ProjectPermission)
    private readonly permissionRepo: Repository<ProjectPermission>,
    @InjectRepository(ProjectEnvVar)
    private readonly envVarRepo: Repository<ProjectEnvVar>,
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  private extractMissingItems(history: Array<{ role: string; content: string }>): string[] {
    const lastAssistant = [...(history || [])]
      .reverse()
      .find((m) => m.role === 'assistant');
    if (!lastAssistant) return [];
    const match = lastAssistant.content.match(/```json\s*([\s\S]*?)```/);
    if (!match) return [];
    try {
      const parsed = JSON.parse(match[1]);
      return Array.isArray(parsed.missing_items) ? parsed.missing_items : [];
    } catch {
      return [];
    }
  }

  /**
   * 같은 이메일 도메인의 다른 사용자가 만든 프로젝트 — 권한 없음 (viewer 자동)
   */
  async findTeamProjects(userId: string) {
    const me = await this.userRepo.findOne({ where: { id: userId } });
    if (!me) return [];
    const domain = me.email.split('@')[1];
    if (!domain) return [];

    // 같은 도메인의 모든 유저
    const teammates = await this.userRepo
      .createQueryBuilder('u')
      .where('u.email LIKE :pat', { pat: `%@${domain}` })
      .andWhere('u.id != :me', { me: userId })
      .getMany();
    const teammateIds = teammates.map((u) => u.id);
    if (teammateIds.length === 0) return [];

    // 내가 이미 권한 있는 프로젝트는 제외
    const myPerms = await this.permissionRepo.find({ where: { user_id: userId } });
    const myProjectIds = new Set(myPerms.map((p) => p.project_id));

    const allProjects = await this.projectRepo
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.user', 'u')
      .where('p.user_id IN (:...ids)', { ids: teammateIds })
      .orderBy('p.created_at', 'DESC')
      .getMany();

    const teamProjects = allProjects.filter((p) => !myProjectIds.has(p.id));
    if (teamProjects.length === 0) return [];

    // missing_items
    const conversations = await this.conversationRepo.find({
      where: teamProjects.map((p) => ({
        project_id: p.id,
        type: 'scoring' as const,
      })),
    });
    const missingMap = new Map<string, string[]>();
    for (const c of conversations) {
      missingMap.set(c.project_id, this.extractMissingItems(c.conversation_history));
    }

    return teamProjects.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      score: p.score,
      port: p.port,
      ownerName: p.user?.name || 'Unknown',
      myRole: 'viewer' as const,
      missing_items: missingMap.get(p.id) || [],
      created_at: p.created_at,
    }));
  }

  async findAllForUser(userId: string) {
    const permissions = await this.permissionRepo.find({
      where: { user_id: userId },
      relations: ['project', 'project.user'],
    });

    const validPerms = permissions.filter((p) => p.project);
    const projectIds = validPerms.map((p) => p.project.id);

    // 각 프로젝트의 scoring 대화에서 missing_items 뽑기
    const conversations = projectIds.length
      ? await this.conversationRepo.find({
          where: projectIds.map((id) => ({
            project_id: id,
            type: 'scoring' as const,
          })),
        })
      : [];
    const missingMap = new Map<string, string[]>();
    for (const c of conversations) {
      missingMap.set(c.project_id, this.extractMissingItems(c.conversation_history));
    }

    return validPerms.map((p) => ({
      id: p.project.id,
      title: p.project.title,
      status: p.project.status,
      score: p.project.score,
      port: p.project.port,
      ownerName: p.project.user?.name || 'Unknown',
      myRole: p.role,
      missing_items: missingMap.get(p.project.id) || [],
      created_at: p.project.created_at,
    }));
  }

  async create(userId: string, title: string): Promise<Project> {
    const project = this.projectRepo.create({
      user_id: userId,
      title,
      status: 'scoring',
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

  async findOne(id: string): Promise<Project> {
    const project = await this.projectRepo.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!project) {
      throw new NotFoundException('프로젝트를 찾을 수 없습니다.');
    }
    return project;
  }

  async getUserRole(
    projectId: string,
    userId: string,
  ): Promise<string | null> {
    const perm = await this.permissionRepo.findOne({
      where: { project_id: projectId, user_id: userId },
    });
    return perm?.role || null;
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
    await this.permissionRepo.delete({ project_id: id });
    await this.envVarRepo.delete({ project_id: id });
    await this.projectRepo.delete(id);
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
    if (perm.role === 'owner')
      throw new ForbiddenException('소유자 권한은 제거할 수 없습니다.');

    await this.permissionRepo.remove(perm);
  }

  // --- Service control ---
  async stopProject(projectId: string, userId: string) {
    await this.requireRole(projectId, userId, ['owner', 'editor']);
    await this.projectRepo.update(projectId, { status: 'stopped' });
    return { message: '서비스가 중지되었습니다.' };
  }

  async restartProject(projectId: string, userId: string) {
    await this.requireRole(projectId, userId, ['owner', 'editor']);
    await this.projectRepo.update(projectId, { status: 'deployed' });
    return { message: '서비스가 재시작되었습니다.' };
  }

  // --- ENV ---
  async getEnvVars(projectId: string, userId: string) {
    await this.requireRole(projectId, userId, ['owner', 'editor']);
    const vars = await this.envVarRepo.find({
      where: { project_id: projectId },
    });
    // Mask values
    return vars.map((v) => ({
      ...v,
      encrypted_value: v.is_filled
        ? `${(v.encrypted_value || '').substring(0, 4)}****`
        : null,
    }));
  }

  async setEnvVars(
    projectId: string,
    userId: string,
    vars: Array<{ key: string; value: string }>,
  ) {
    await this.requireRole(projectId, userId, ['owner', 'editor']);

    for (const { key, value } of vars) {
      let envVar = await this.envVarRepo.findOne({
        where: { project_id: projectId, key_name: key },
      });

      if (envVar) {
        envVar.encrypted_value = value; // TODO: actual encryption
        envVar.is_filled = !!value;
        await this.envVarRepo.save(envVar);
      } else {
        envVar = this.envVarRepo.create({
          id: uuidv4(),
          project_id: projectId,
          key_name: key,
          encrypted_value: value,
          is_filled: !!value,
          is_required: true,
        });
        await this.envVarRepo.save(envVar);
      }
    }

    // Check if all required env vars are filled
    const allVars = await this.envVarRepo.find({
      where: { project_id: projectId },
    });
    const allRequiredFilled = allVars
      .filter((v) => v.is_required)
      .every((v) => v.is_filled);

    if (allRequiredFilled) {
      const project = await this.projectRepo.findOne({
        where: { id: projectId },
      });
      if (project?.status === 'awaiting_env') {
        await this.projectRepo.update(projectId, { status: 'deployed' });
      }
    }

    return { success: true, all_required_filled: allRequiredFilled };
  }
}
