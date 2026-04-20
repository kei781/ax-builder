import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectPermission } from '../projects/entities/project-permission.entity.js';
import type { PermissionRole } from '../projects/entities/project-permission.entity.js';
import { User } from '../auth/entities/user.entity.js';

export const REQUIRE_ROLES_KEY = 'require_roles';

export const RequireRoles = (...roles: PermissionRole[]) =>
  SetMetadata(REQUIRE_ROLES_KEY, roles);

/**
 * Checks that req.user has one of the required roles on the path's :id project.
 * Queries project_permissions directly — no dependency on ProjectsService.
 *
 * 플랫폼 관리자(is_admin) 우회 — ARCHITECTURE §9.5:
 *   1순위: JWT payload의 is_admin (O(1), fast path)
 *   2순위: DB users.is_admin (JWT가 예전 버전이라 is_admin 필드가 없거나,
 *          ADMIN_EMAILS 승급 후 재로그인하지 않은 유저를 위한 fallback)
 */
@Injectable()
export class ProjectPermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(ProjectPermission)
    private readonly permissionRepo: Repository<ProjectPermission>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles =
      this.reflector.getAllAndOverride<PermissionRole[] | undefined>(
        REQUIRE_ROLES_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];

    if (requiredRoles.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const projectId: string | undefined = req.params?.id;
    const userId: string | undefined = req.user?.id;
    if (!projectId || !userId) {
      throw new ForbiddenException('권한 확인에 필요한 정보가 없습니다.');
    }

    // 1순위: JWT의 is_admin (재로그인한 admin 유저).
    if (req.user?.is_admin === true) return true;

    // 2순위: DB fallback. JWT가 예전 버전이거나 ADMIN_EMAILS 승급 후
    // 재로그인하지 않은 경우에도 즉시 admin 권한 활성화.
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (user?.is_admin) return true;

    const perm = await this.permissionRepo.findOne({
      where: { project_id: projectId, user_id: userId },
    });
    const role = perm?.role;
    if (!role || !requiredRoles.includes(role as PermissionRole)) {
      throw new ForbiddenException('권한이 없습니다.');
    }

    return true;
  }
}
