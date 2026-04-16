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

export const REQUIRE_ROLES_KEY = 'require_roles';

export const RequireRoles = (...roles: PermissionRole[]) =>
  SetMetadata(REQUIRE_ROLES_KEY, roles);

/**
 * Checks that req.user has one of the required roles on the path's :id project.
 * Queries project_permissions directly — no dependency on ProjectsService.
 */
@Injectable()
export class ProjectPermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(ProjectPermission)
    private readonly permissionRepo: Repository<ProjectPermission>,
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
