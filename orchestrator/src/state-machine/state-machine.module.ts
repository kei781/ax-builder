import { Module, forwardRef } from '@nestjs/common';
import { StateMachineService } from './state-machine.service.js';
import { ProjectsModule } from '../projects/projects.module.js';

@Module({
  // ProjectsModule → EnvsModule → StateMachineModule 사이클 해소를 위해
  // forwardRef로 감쌈 (ADR 0006 restart 라우팅 때문에 생긴 의존).
  imports: [forwardRef(() => ProjectsModule)],
  providers: [StateMachineService],
  exports: [StateMachineService],
})
export class StateMachineModule {}
