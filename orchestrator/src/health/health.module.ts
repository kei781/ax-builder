import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { AgentsModule } from '../agents/agents.module.js';

@Module({
  imports: [AgentsModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
