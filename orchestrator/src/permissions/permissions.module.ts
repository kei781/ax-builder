import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectPermissionsGuard } from './permissions.guard.js';
import { ProjectPermission } from '../projects/entities/project-permission.entity.js';

/**
 * Provides the ProjectPermissionsGuard for use in any controller.
 * The guard queries project_permissions directly (no ProjectsModule dep).
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProjectPermission])],
  providers: [ProjectPermissionsGuard],
  exports: [ProjectPermissionsGuard],
})
export class PermissionsModule {}
