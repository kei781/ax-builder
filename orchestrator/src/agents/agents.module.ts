import { Module } from '@nestjs/common';
import { PlanningClient } from './planning.client.js';
import { BuildingRunner } from './building.runner.js';
import { WebsocketModule } from '../websocket/websocket.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { StateMachineModule } from '../state-machine/state-machine.module.js';
import { HandoffsModule } from '../handoffs/handoffs.module.js';
import { BuildsModule } from '../builds/builds.module.js';
import { InfraModule } from '../infra/infra.module.js';

/**
 * Agent process lifecycle management.
 *
 * This module owns the orchestrator-side of agent communication:
 *   - PlanningClient:   WS bridge to planning-agent/ Python service
 *   - BuildingRunner:   spawn/monitor of building-agent/ Python process
 *
 * Persistence of agent outputs (sessions, handoffs, builds) is delegated
 * to the respective modules.
 */
@Module({
  imports: [WebsocketModule, ProjectsModule, StateMachineModule, HandoffsModule, BuildsModule, InfraModule],
  providers: [PlanningClient, BuildingRunner],
  exports: [PlanningClient, BuildingRunner],
})
export class AgentsModule {}
