import { Module } from '@nestjs/common';
import { StateMachineService } from './state-machine.service.js';
import { ProjectsModule } from '../projects/projects.module.js';

@Module({
  imports: [ProjectsModule],
  providers: [StateMachineService],
  exports: [StateMachineService],
})
export class StateMachineModule {}
