import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { Project } from './entities/project.entity.js';
import { Conversation } from './entities/conversation.entity.js';
import { ProjectPermission } from './entities/project-permission.entity.js';
import { ProjectEnvVar } from './entities/project-env-var.entity.js';
import { User } from '../auth/entities/user.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      Conversation,
      ProjectPermission,
      ProjectEnvVar,
      User,
    ]),
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
