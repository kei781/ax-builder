import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

// TODO: Phase 3 — Real-time build progress events

@WebSocketGateway({
  cors: { origin: ['http://localhost:3123', 'https://hackathon.acaxiaa.store'] },
  namespace: '/ws',
})
export class BuildGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket) {
    console.log(`WebSocket client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`WebSocket client disconnected: ${client.id}`);
  }

  emitProgress(projectId: string, data: Record<string, unknown>) {
    this.server.to(`project:${projectId}`).emit('build_progress', data);
  }

  emitComplete(projectId: string, data: Record<string, unknown>) {
    this.server.to(`project:${projectId}`).emit('build_complete', data);
  }

  emitFailed(projectId: string, data: Record<string, unknown>) {
    this.server.to(`project:${projectId}`).emit('build_failed', data);
  }

  emitLog(projectId: string, line: string) {
    // 모든 연결된 클라이언트에 브로드캐스트 (현재는 join 로직 없음)
    this.server.emit('build_log', { projectId, line, at: Date.now() });
  }
}
