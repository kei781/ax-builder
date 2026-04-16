import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs/promises';

import { Project } from '../projects/entities/project.entity.js';
import { ProjectPermission } from '../projects/entities/project-permission.entity.js';
import { Session } from '../sessions/entities/session.entity.js';
import { ConversationMessage } from '../sessions/entities/conversation-message.entity.js';
import { AgentLog } from '../builds/entities/agent-log.entity.js';
import { StateMachineService } from '../state-machine/state-machine.service.js';
import { PlanningClient } from '../agents/planning.client.js';
import { BuildGateway } from '../websocket/build.gateway.js';
import type { AgentEvent } from '../websocket/events.js';

/**
 * Orchestrator-side chat flow.
 *
 *   POST /projects/:id/chat  ─▶  persist user message
 *                             ─▶  ensure Session exists
 *                             ─▶  draft → planning transition on first turn
 *                             ─▶  fetch history from DB
 *                             ─▶  dispatch to Planning Agent
 *                             ─▶  stream tokens back to frontend via BuildGateway
 *                             ─▶  persist assistant message on completion
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly projectsBase: string;

  /**
   * In-memory chat lock per project. When a user sends a message, the
   * project is locked until the assistant's `completion` event arrives.
   * Other users in the same room see the lock via WS and their input
   * is rejected (ARCHITECTURE §8.3).
   */
  private readonly chatLocks = new Map<
    string,
    { userId: string; lockedAt: number }
  >();

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(ProjectPermission)
    private readonly permissionRepo: Repository<ProjectPermission>,
    @InjectRepository(Session)
    private readonly sessionRepo: Repository<Session>,
    @InjectRepository(ConversationMessage)
    private readonly messageRepo: Repository<ConversationMessage>,
    @InjectRepository(AgentLog)
    private readonly agentLogRepo: Repository<AgentLog>,
    private readonly dataSource: DataSource,
    private readonly stateMachine: StateMachineService,
    private readonly planning: PlanningClient,
    private readonly gateway: BuildGateway,
  ) {
    this.projectsBase = path.resolve(process.cwd(), '..', 'projects');
  }

  /** Fetch the full ordered history of the project's current session. */
  async getHistory(projectId: string, userId: string) {
    await this.requireMembership(projectId, userId);

    const project = await this.projectRepo.findOne({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');

    if (!project.current_session_id) return { session_id: null, messages: [] };

    const messages = await this.messageRepo.find({
      where: { session_id: project.current_session_id },
      order: { created_at: 'ASC' },
    });

    return {
      session_id: project.current_session_id,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        author_user_id: m.author_user_id,
        created_at: m.created_at,
      })),
    };
  }

  /**
   * Ingest a user message and kick off Planning Agent inference.
   * Returns immediately after dispatch — streaming tokens arrive via
   * BuildGateway events; the final assistant message is persisted in the
   * `agent:event` handler when we see `event_type: 'completion'`.
   */
  async sendUserMessage(
    projectId: string,
    userId: string,
    content: string,
  ): Promise<{ session_id: string; message_id: string }> {
    await this.requireMembership(projectId, userId, ['owner', 'editor']);

    if (!content.trim()) {
      throw new ForbiddenException('빈 메시지는 보낼 수 없습니다.');
    }

    const project = await this.projectRepo.findOne({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');

    // Lock check (H1 nonsense-input lock).
    if (project.locked_until && project.locked_until > new Date()) {
      throw new ForbiddenException(
        `프로젝트가 잠겨있습니다: ${project.lock_reason ?? 'locked'}`,
      );
    }

    // Concurrent chat lock (ARCHITECTURE §8.3): one turn at a time per
    // project. If another user is mid-turn, reject.
    const existingLock = this.chatLocks.get(projectId);
    if (existingLock) {
      // Safety: if the lock is older than 5min, it's probably stale
      // (crashed turn). Auto-release.
      const staleMs = 5 * 60 * 1000;
      if (Date.now() - existingLock.lockedAt > staleMs) {
        this.chatLocks.delete(projectId);
      } else {
        throw new ForbiddenException(
          '다른 사용자의 메시지 처리 중입니다. 잠시 후 다시 시도해주세요.',
        );
      }
    }
    this.chatLocks.set(projectId, { userId, lockedAt: Date.now() });

    // Concurrency limit (ARCHITECTURE §10.1): 2 concurrent planning sessions
    // per user. Only check on first turn (state=draft → planning), not on
    // subsequent messages to an already-active session.
    if (project.state === 'draft') {
      const activePlanning = await this.projectRepo
        .createQueryBuilder('p')
        .where('p.owner_id = :ownerId', { ownerId: project.owner_id })
        .andWhere('p.state IN (:...states)', {
          states: ['planning', 'plan_ready'],
        })
        .getCount();
      if (activePlanning >= 2) {
        this.chatLocks.delete(projectId); // release lock since we're rejecting
        throw new ForbiddenException(
          '유저당 동시 기획 세션은 2개까지 가능합니다. 기존 프로젝트를 완료하거나 삭제한 후 시도해주세요.',
        );
      }
    }

    // Lazy 30min-idle sweep before we pick a session — turns any long-idle
    // active sessions into `suspended` so ensureActiveSession can then
    // resume them explicitly (makes the state transition auditable).
    await this.suspendStaleSessions();

    // First turn? Ensure project dir, session, and state transition.
    const session = await this.ensureActiveSession(project);
    const isFirstTurn = project.state === 'draft';
    if (isFirstTurn) {
      await this.ensureProjectDir(project);
      await this.stateMachine.transition(
        projectId,
        'planning',
        'first user message',
      );
    }

    // Persist the user message before dispatching. Single-writer pattern:
    // all conversation_messages rows are written here, never inside the
    // Planning Agent.
    const userMessage = this.messageRepo.create({
      session_id: session.id,
      role: 'user',
      content,
      author_user_id: userId,
    });
    const saved = await this.messageRepo.save(userMessage);

    // Bump session activity (30min unload trigger). Also advance the
    // checkpoint timestamp if >10min since the last one (ARCHITECTURE §3.2 /
    // M1). We do this lazily on each turn rather than with a background
    // worker — the value isn't observed between turns anyway.
    const now = new Date();
    const checkpointInterval = 10 * 60 * 1000;
    const lastCheckpoint = session.last_checkpoint_at?.getTime() ?? 0;
    session.last_activity_at = now;
    if (now.getTime() - lastCheckpoint >= checkpointInterval) {
      session.last_checkpoint_at = now;
    }
    await this.sessionRepo.save(session);

    // Broadcast the user's message into the project room so other viewers
    // see it in near-real-time without refetching.
    this.gateway.emit({
      agent: 'planning',
      project_id: projectId,
      session_id: session.id,
      event_type: 'log',
      payload: {
        kind: 'user_message',
        id: saved.id,
        content,
        author_user_id: userId,
      },
    });

    // Fetch the tail of the history. HISTORY_TRUNCATE caps the token budget
    // we send to Planning; anything beyond is relegated to summaries in a
    // future iteration (ARCHITECTURE §5.3).
    const allMessages = await this.messageRepo.find({
      where: { session_id: session.id },
      order: { created_at: 'ASC' },
    });
    const HISTORY_TRUNCATE = 50;
    const history = allMessages.slice(-HISTORY_TRUNCATE);

    // Dispatch to Planning Agent. The PlanningClient's agent:event callback
    // forwards all downstream events — we return immediately.
    await this.planning.sendUserMessage({
      projectId,
      sessionId: session.id,
      history: history.map((m) => ({ role: m.role, content: m.content ?? '' })),
      userMessage: content,
      onEvent: (event) => this.handleAgentEvent(event, session.id),
    });

    return { session_id: session.id, message_id: saved.id };
  }

  /**
   * Lazy idle check run before each turn. Sessions whose last_activity_at
   * is older than 30min are marked `suspended` here so observability tables
   * stay honest without a background worker. The caller will usually
   * reactivate the session immediately via ensureActiveSession.
   */
  private async suspendStaleSessions(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    await this.sessionRepo
      .createQueryBuilder()
      .update(Session)
      .set({ state: 'suspended', suspended_at: () => 'CURRENT_TIMESTAMP' })
      .where('state = :state', { state: 'active' })
      .andWhere('last_activity_at < :cutoff', { cutoff })
      .execute();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async requireMembership(
    projectId: string,
    userId: string,
    allowedRoles: string[] = ['owner', 'editor', 'viewer'],
  ) {
    const perm = await this.permissionRepo.findOne({
      where: { project_id: projectId, user_id: userId },
    });
    if (!perm) {
      // Viewers see public projects without a row — allow read for 'viewer' only.
      if (allowedRoles.includes('viewer')) return;
      throw new ForbiddenException('권한이 없습니다.');
    }
    if (!allowedRoles.includes(perm.role)) {
      throw new ForbiddenException('권한이 없습니다.');
    }
  }

  /**
   * Ensure the project has an active session. Cross-session resume
   * (ARCHITECTURE §5.4) — a `suspended` session is reactivated rather than
   * replaced with a new one so the message history is preserved.
   *
   * New session is created only when:
   *   - project has no current_session_id yet, OR
   *   - the referenced session is `archived` (post-deploy modify flow)
   */
  private async ensureActiveSession(project: Project): Promise<Session> {
    if (project.current_session_id) {
      const existing = await this.sessionRepo.findOne({
        where: { id: project.current_session_id },
      });
      if (existing && existing.state === 'active') {
        return existing;
      }
      if (existing && existing.state === 'suspended') {
        existing.state = 'active';
        existing.last_activity_at = new Date();
        await this.sessionRepo.save(existing);
        this.logger.log(`Resumed suspended session ${existing.id}`);
        return existing;
      }
      // 'archived' or missing → fall through to create a new session
    }

    return this.dataSource.transaction(async (manager) => {
      const session = manager.create(Session, {
        project_id: project.id,
        state: 'active',
        last_activity_at: new Date(),
        last_checkpoint_at: new Date(),
      });
      const savedSession = await manager.save(session);
      await manager.update(Project, project.id, {
        current_session_id: savedSession.id,
      });
      return savedSession;
    });
  }

  private async ensureProjectDir(project: Project): Promise<void> {
    const dir = path.join(this.projectsBase, project.id);
    await fs.mkdir(dir, { recursive: true });
    if (!project.project_path) {
      await this.projectRepo.update(project.id, { project_path: dir });
    }
  }

  /**
   * Called for every event streamed back from the Planning Agent.
   *   (a) forward to the frontend via BuildGateway
   *   (b) persist the final assistant message on `completion`
   *   (c) record tool invocations to agent_logs (ARCHITECTURE §13.1)
   */
  private async handleAgentEvent(
    event: AgentEvent,
    sessionId: string,
  ): Promise<void> {
    this.gateway.emit(event);

    // Tool call audit — we record both the call and the result so failures
    // and arguments are replayable offline. Token/progress events are high
    // volume; we skip them on purpose.
    if (
      event.event_type === 'tool_call' ||
      event.event_type === 'tool_result' ||
      event.event_type === 'error'
    ) {
      try {
        await this.agentLogRepo.save(
          this.agentLogRepo.create({
            project_id: event.project_id,
            session_id: sessionId,
            agent: 'planning',
            event_type: event.event_type,
            payload: event.payload ?? null,
          }),
        );
      } catch (err: any) {
        this.logger.warn(`agent_log write failed: ${err?.message ?? err}`);
      }
    }

    // propose_handoff notification — the Python tool writes the handoff row
    // and transitions projects.state directly via SQL; here we surface the
    // transition to the frontend so UI can flip to "빌드 시작" mode.
    if (event.event_type === 'tool_result') {
      const payload = (event.payload ?? {}) as {
        name?: string;
        result?: {
          ok?: boolean;
          accepted?: boolean;
          transitioned_to_plan_ready?: boolean;
          handoff_id?: string;
          min_completeness?: number;
          is_sufficient?: boolean;
        };
      };
      const r = payload.result;
      if (
        payload.name === 'propose_handoff' &&
        r?.ok === true &&
        r?.transitioned_to_plan_ready === true
      ) {
        this.gateway.emit({
          agent: 'planning',
          project_id: event.project_id,
          session_id: sessionId,
          event_type: 'progress',
          phase: 'plan_ready',
          progress_percent: 100,
          payload: {
            detail: r.is_sufficient
              ? '충분 조건 충족 — 빌드 준비 완료'
              : '최소 조건 충족 — 빌드 준비 완료',
            handoff_id: r.handoff_id,
            min_completeness: r.min_completeness,
            is_sufficient: !!r.is_sufficient,
          },
        });
      }
    }

    if (event.event_type === 'completion') {
      const payload = (event.payload ?? {}) as { role?: string; content?: string };
      if (payload.role === 'assistant' && typeof payload.content === 'string') {
        await this.messageRepo.save(
          this.messageRepo.create({
            session_id: sessionId,
            role: 'assistant',
            content: payload.content,
          }),
        );
      }
      // Bump activity on completion so idle timer tracks assistant output too.
      await this.sessionRepo.update(sessionId, { last_activity_at: new Date() });
      // Release concurrent chat lock.
      this.chatLocks.delete(event.project_id);
    }

    if (event.event_type === 'error') {
      this.logger.error(
        `Planning error for session ${sessionId}: ${JSON.stringify(event.payload)}`,
      );
      // Release lock on error too — otherwise project is permanently stuck.
      this.chatLocks.delete(event.project_id);
    }
  }
}
