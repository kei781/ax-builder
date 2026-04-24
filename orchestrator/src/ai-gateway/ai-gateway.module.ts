import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Project } from '../projects/entities/project.entity.js';
import { AiGatewayService } from './ai-gateway.service.js';
import { AiGatewayController } from './ai-gateway.controller.js';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([Project])],
  controllers: [AiGatewayController],
  providers: [AiGatewayService],
  exports: [AiGatewayService],
})
export class AiGatewayModule {}
