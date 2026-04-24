import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectPermissionsGuard } from './permissions.guard.js';
import { ProjectPermission } from '../projects/entities/project-permission.entity.js';
import { User } from '../auth/entities/user.entity.js';

/**
 * Provides the ProjectPermissionsGuard for use in any controller.
 * Guard queries project_permissions directly (no ProjectsModule dep).
 * User 엔티티는 admin fallback 확인용 (ARCHITECTURE §9.5).
 *
 * `@Global()` — Guard는 여러 module(build/chat/envs/projects)에서 쓰인다.
 * Nest가 Guard 인스턴스화 시 사용 측 모듈의 provider scope에서 의존성을
 * resolve하므로, User Repository를 일일이 각 consumer 모듈에 forFeature
 * 하는 대신 PermissionsModule을 글로벌로 승격해 어디서든 보이게 한다.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ProjectPermission, User])],
  providers: [ProjectPermissionsGuard],
  exports: [ProjectPermissionsGuard, TypeOrmModule],
})
export class PermissionsModule {}
