import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectPermissionsGuard } from './permissions.guard.js';
import { ProjectPermission } from '../projects/entities/project-permission.entity.js';
import { User } from '../auth/entities/user.entity.js';

/**
 * Provides the ProjectPermissionsGuard for use in any controller.
 * The guard queries project_permissions directly (no ProjectsModule dep).
 * User 엔티티는 admin fallback 확인용 (ARCHITECTURE §9.5).
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProjectPermission, User])],
  providers: [ProjectPermissionsGuard],
  exports: [ProjectPermissionsGuard],
})
export class PermissionsModule {}
