import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { Project } from './entities/project.entity.js';
import { ProjectPermission } from './entities/project-permission.entity.js';
import { User } from '../auth/entities/user.entity.js';
import { InfraModule } from '../infra/infra.module.js';
import { PermissionsModule } from '../permissions/permissions.module.js';
import { EnvsModule } from '../envs/envs.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Project, ProjectPermission, User]),
    InfraModule,
    PermissionsModule,
    // Cycle: ProjectsModule → EnvsModule → StateMachineModule → ProjectsModule.
    // forwardRef로 끊음.
    forwardRef(() => EnvsModule),
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService, TypeOrmModule],
})
export class ProjectsModule {}
