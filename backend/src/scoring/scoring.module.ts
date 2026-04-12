import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScoringService } from './scoring.service.js';
import { ScoringController } from './scoring.controller.js';
import { Conversation } from '../projects/entities/conversation.entity.js';
import { Project } from '../projects/entities/project.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([Conversation, Project])],
  controllers: [ScoringController],
  providers: [ScoringService],
  exports: [ScoringService],
})
export class ScoringModule {}
