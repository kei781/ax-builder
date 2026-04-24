import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket, io } from 'socket.io-client';
import type { AgentEvent } from '../websocket/events.js';

export interface PlanningTurnInput {
  projectId: string;
  sessionId: string | null;
  history: Array<{ role: string; content: string }>;
  userMessage: string;
  /**
   * Owner profile + project title — 2026-04-23 추가 (베키 사례 대응).
   * planning-agent가 시스템 프롬프트 상단에 런타임 주입해 비개발자/개발자
   * 분기와 프로젝트 도메인 고정에 사용. 누락 시 planning-agent가
   * 비개발자/detailed/null 기본값으로 fallback.
   */
  profileIsDeveloper: boolean;
  profileExplainDepth: 'brief' | 'detailed';
  projectTitle: string;
  onEvent: (event: AgentEvent) => void | Promise<void>;
}

/**
 * Socket.IO client to the Planning Agent Python service.
 *
 * Connection strategy: one long-lived connection shared across all projects.
 * Event routing: the `agent:event` stream is demultiplexed by project_id
 * into per-project callbacks registered via sendUserMessage().
 *
 * Reconnection is handled by socket.io-client's built-in logic.
 */
@Injectable()
export class PlanningClient implements OnModuleInit {
  private readonly logger = new Logger(PlanningClient.name);
  private socket: Socket | null = null;
  private readonly url: string;

  /** project_id → active turn callback. One turn per project at a time. */
  private readonly turnCallbacks = new Map<
    string,
    (event: AgentEvent) => void | Promise<void>
  >();

  constructor(private readonly config: ConfigService) {
    this.url = this.config.get<string>(
      'PLANNING_AGENT_URL',
      'http://127.0.0.1:4100',
    );
  }

  onModuleInit(): void {
    this.connect();
  }

  private connect(): void {
    if (this.socket) return;

    this.logger.log(`Connecting to Planning Agent at ${this.url}`);
    this.socket = io(this.url, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });

    this.socket.on('connect', () => {
      this.logger.log(`Connected to Planning Agent (sid=${this.socket?.id})`);
    });

    this.socket.on('disconnect', (reason: string) => {
      this.logger.warn(`Disconnected from Planning Agent: ${reason}`);
    });

    this.socket.on('connect_error', (err: Error) => {
      this.logger.error(`Planning Agent connect error: ${err.message}`);
    });

    this.socket.on('agent:event', async (event: AgentEvent) => {
      const cb = this.turnCallbacks.get(event.project_id);
      if (!cb) {
        // Could be a stale event after cancellation — log but don't crash.
        this.logger.debug(
          `agent:event for unknown project ${event.project_id}: ${event.event_type}`,
        );
        return;
      }

      try {
        await cb(event);
      } catch (err: any) {
        this.logger.error(`onEvent callback threw: ${err?.message ?? err}`);
      }

      if (event.event_type === 'completion' || event.event_type === 'error') {
        this.turnCallbacks.delete(event.project_id);
      }
    });
  }

  private ensureConnected(): void {
    if (!this.socket?.connected) {
      throw new Error(
        'Planning Agent is not connected. Start planning-agent service.',
      );
    }
  }

  async sendUserMessage(input: PlanningTurnInput): Promise<void> {
    this.ensureConnected();

    // If a prior turn is still in-flight for this project, replace its
    // callback — the user's new message is effectively a cancel+resend.
    // (Step 7 will tighten this into a proper cancel protocol.)
    if (this.turnCallbacks.has(input.projectId)) {
      this.logger.warn(
        `Overwriting in-flight turn for project ${input.projectId}`,
      );
    }
    this.turnCallbacks.set(input.projectId, input.onEvent);

    this.socket!.emit('chat:turn', {
      project_id: input.projectId,
      session_id: input.sessionId,
      history: input.history,
      user_message: input.userMessage,
      profile_is_developer: input.profileIsDeveloper,
      profile_explain_depth: input.profileExplainDepth,
      project_title: input.projectTitle,
    });
  }

  cancelCurrentTurn(projectId: string): void {
    this.turnCallbacks.delete(projectId);
  }

  isConnected(): boolean {
    return !!this.socket?.connected;
  }
}
