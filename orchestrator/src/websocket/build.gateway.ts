import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import type { AgentEvent } from './events.js';

/**
 * Socket.io gateway that broadcasts unified agent events to frontend clients
 * joined to `project:{id}` rooms.
 *
 * ARCHITECTURE §12.3 — the payload shape is `AgentEvent` for all event types.
 * We emit on a single channel (`agent_event`) rather than one-per-type so
 * the frontend can switch on `event_type` and doesn't need to bind a dozen
 * listeners.
 */
@WebSocketGateway({
  cors: { origin: ['http://localhost:3123', 'https://hackathon.acaxiaa.store'] },
  namespace: '/ws',
})
export class BuildGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(BuildGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket) {
    this.logger.log(`WebSocket client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`WebSocket client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join')
  handleJoin(client: Socket, payload: { projectId: string }) {
    const room = `project:${payload.projectId}`;
    client.join(room);
    this.logger.log(`Client ${client.id} joined room ${room}`);
  }

  /**
   * Emit a unified agent event. Stamp `at` if not provided.
   */
  emit(event: AgentEvent): void {
    const stamped: AgentEvent = { ...event, at: event.at ?? Date.now() };
    this.server.to(`project:${event.project_id}`).emit('agent_event', stamped);
  }
}
