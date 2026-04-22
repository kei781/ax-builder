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
import { User } from '../auth/entities/user.entity.js';
import { Session } from '../sessions/entities/session.entity.js';
import { ConversationMessage } from '../sessions/entities/conversation-message.entity.js';
import { AgentLog } from '../builds/entities/agent-log.entity.js';
import { Handoff } from '../handoffs/entities/handoff.entity.js';
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

  /**
   * 턴 단위 도구 호출 카운터 — 회고 §6/9 환각 감지용.
   * sendUserMessage 시작 시 0으로 세팅, tool_call 이벤트마다 증가,
   * completion 이벤트에 0이면 AI 텍스트 환각 감지 가동.
   */
  private readonly turnToolCallCount = new Map<string, number>();

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
    @InjectRepository(Handoff)
    private readonly handoffRepo: Repository<Handoff>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
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

    if (!project.current_session_id) {
      return { session_id: null, messages: [], readiness: null };
    }

    const [messages, handoff] = await Promise.all([
      this.messageRepo.find({
        where: { session_id: project.current_session_id },
        order: { created_at: 'ASC' },
      }),
      this.handoffRepo.findOne({
        where: { session_id: project.current_session_id },
        order: { created_at: 'DESC' },
      }),
    ]);

    // Build readiness from latest handoff (if handoff exists — plan_ready state).
    // is_sufficient 플래그를 추가: min >= 0.85 (충분 조건).
    // can_build: min >= 0.6 + unresolved 없음 (최소 조건).
    // 프론트가 두 값을 구분해 "최소 조건 충족(보강 권장)" vs "충분 조건 충족" 배지 분기.
    let readiness: {
      completeness: Record<string, number>;
      score: number;
      can_build: boolean;
      is_sufficient: boolean;
      summary: string;
      label: string;
    } | null = null;

    if (handoff) {
      const values = Object.values(handoff.completeness) as number[];
      const minScore = Math.min(...values);
      const canBuild = minScore >= 0.6 && handoff.unresolved_questions.length === 0;
      const isSufficient = minScore >= 0.85 && handoff.unresolved_questions.length === 0;
      readiness = {
        completeness: handoff.completeness,
        score: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000),
        can_build: canBuild,
        is_sufficient: isSufficient,
        summary: '',
        label: isSufficient
          ? '충분 조건 충족'
          : canBuild
            ? '최소 조건 충족 (보강 권장)'
            : '보강 필요',
      };
    } else {
      // No handoff yet — fall back to the latest evaluate_readiness tool_result
      // stored in agent_logs (live scoring mid-conversation).
      const latestEval = await this.agentLogRepo
        .createQueryBuilder('log')
        .where('log.project_id = :pid', { pid: projectId })
        .andWhere("log.event_type = 'tool_result'")
        .andWhere("json_extract(log.payload, '$.name') = 'evaluate_readiness'")
        .andWhere("json_extract(log.payload, '$.result.ok') = 1")
        .orderBy('log.created_at', 'DESC')
        .getOne();
      if (latestEval?.payload) {
        const p = latestEval.payload as {
          result?: {
            completeness?: Record<string, number>;
            score?: number;
            can_build?: boolean;
            is_sufficient?: boolean;
            summary?: string;
            label?: string;
          };
        };
        if (p.result?.completeness) {
          // evaluate_readiness는 min>=0.85 여부를 모를 수 있으니 로컬에서 재계산.
          const vals = Object.values(p.result.completeness) as number[];
          const minScore = vals.length ? Math.min(...vals) : 0;
          const canBuild = p.result.can_build ?? minScore >= 0.6;
          const isSufficient = p.result.is_sufficient ?? minScore >= 0.85;
          readiness = {
            completeness: p.result.completeness,
            score: p.result.score ?? 0,
            can_build: canBuild,
            is_sufficient: isSufficient,
            summary: p.result.summary ?? '',
            label:
              p.result.label ||
              (isSufficient
                ? '충분 조건 충족'
                : canBuild
                  ? '최소 조건 충족 (보강 권장)'
                  : '보강 필요'),
          };
        }
      }
    }

    return {
      session_id: project.current_session_id,
      readiness,
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
    // 환각 감지 카운터 reset — 이번 턴의 tool_call 이벤트 수를 센다.
    this.turnToolCallCount.set(projectId, 0);

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

    // ADR 0008 §D5 후속 — 업데이트 사이클은 **세션을 격리**한다.
    // deployed → planning_update로 진입할 때, 이전 planning/update 대화는
    // 전부 PRD·DESIGN에 반영돼있다는 전제. AI 컨텍스트가 과거 대화로
    // 오염되면 "개발 전 단계"처럼 답변하는 오류 발생. 여기서 기존 session을
    // archived로 돌리고 current_session_id를 null로 비운 다음,
    // ensureActiveSession이 새 session을 만들게 한다.
    const isStartingUpdateCycle = project.state === 'deployed';
    if (isStartingUpdateCycle) {
      await this.archiveCurrentSessionForUpdate(project);
    }

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
    } else if (project.state === 'failed') {
      // Resume planning after a build failure — user is fixing the PRD.
      await this.stateMachine.transition(
        projectId,
        'planning',
        'resuming after failure',
      );
    } else if (isStartingUpdateCycle) {
      // deployed → planning_update. 세션은 위에서 이미 새로 만들어졌다.
      try {
        await this.stateMachine.transition(
          projectId,
          'planning_update',
          'user started modify via chat (fresh session)',
        );
      } catch (err) {
        this.logger.warn(
          `deployed → planning_update transition failed: ${(err as Error).message}`,
        );
      }
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
    // 플랫폼 관리자(is_admin)는 모든 프로젝트에 대해 owner 권한으로 접근.
    // ARCHITECTURE §9.5. JWT payload에 is_admin이 있으면 그걸 쓰는 게 빠르지만,
    // 이 함수는 userId만 받으므로 DB 조회 1회로 확인.
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (user?.is_admin) return;

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
  /**
   * ADR 0008 §D5 — 업데이트 사이클 진입 시 이전 session을 명시적으로
   * archived로 돌리고 current_session_id를 비운다. 그러면 ensureActiveSession
   * 이 새 session을 만들어 AI 컨텍스트 오염을 차단한다.
   *
   * 원칙: 배포된 앱의 수정 요청은 **PRD.md·DESIGN.md만이 진실원**이다.
   * 이전 대화는 모두 문서에 반영됐다는 전제로 새 세션에서 대화 시작.
   *
   * 추가: 업데이트 취소 경로(ADR 0008 §D4 확장)를 위해 **문서 스냅샷 백업**도
   * 함께 생성. 사용자가 사이클 중 "이 대화 잘못했다, 이전으로" 선택 시
   * 이 백업을 복원해 PRD/DESIGN을 deployed 시점 상태로 되돌린다.
   */
  private async archiveCurrentSessionForUpdate(project: Project): Promise<void> {
    if (!project.current_session_id) return;
    const existing = await this.sessionRepo.findOne({
      where: { id: project.current_session_id },
    });
    if (existing && existing.state !== 'archived') {
      existing.state = 'archived';
      await this.sessionRepo.save(existing);
      this.logger.log(
        `archived session ${existing.id} for update cycle on project ${project.id}`,
      );
    }
    // current_session_id를 비워 ensureActiveSession이 새 session 생성하게.
    await this.projectRepo.update(project.id, { current_session_id: null });
    // 메모리의 project 객체도 sync
    project.current_session_id = null;

    // 문서 백업 — 취소 시 복원용.
    if (project.project_path) {
      await this.backupDocsForUpdate(project.project_path);
    }
  }

  /**
   * 업데이트 사이클 진입 시점의 PRD.md·DESIGN.md 스냅샷을 `.ax-build/
   * pre-update-backup/`에 저장. 이미 존재하면 덮어쓰지 않음 (사이클 중간의
   * write_prd로 인한 덮어쓰기를 원본 복원 가능하게).
   */
  private async backupDocsForUpdate(projectPath: string): Promise<void> {
    const backupDir = path.join(projectPath, '.ax-build', 'pre-update-backup');
    try {
      await fs.mkdir(backupDir, { recursive: true });
    } catch {
      return;
    }
    for (const name of ['PRD.md', 'DESIGN.md']) {
      const src = path.join(projectPath, name);
      const dst = path.join(backupDir, name);
      try {
        // 이미 백업이 있으면 skip — 이번 사이클의 "진짜 원본"은 첫 진입 때 저장됨.
        await fs.access(dst);
        continue;
      } catch {
        /* backup absent, create */
      }
      try {
        const content = await fs.readFile(src, 'utf8');
        await fs.writeFile(dst, content, 'utf8');
      } catch (err: any) {
        this.logger.warn(
          `pre-update backup failed for ${name}: ${err?.message ?? err}`,
        );
      }
    }
    this.logger.log(`pre-update docs backup created at ${backupDir}`);
  }

  /**
   * 업데이트 취소 — 문서 복원 + session archive + state를 deployed로.
   * ADR 0008 §D4 확장. Controller에서 호출.
   */
  async cancelUpdateCycle(
    projectId: string,
    userId: string,
  ): Promise<{ state: string }> {
    await this.requireMembership(projectId, userId, ['owner', 'editor']);
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');

    const cancellableStates = new Set(['planning_update', 'update_ready']);
    if (!cancellableStates.has(project.state)) {
      throw new ForbiddenException(
        `업데이트 사이클 중에만 취소할 수 있습니다. (현재: ${project.state})`,
      );
    }

    // 1) 현재 session archived
    if (project.current_session_id) {
      const sess = await this.sessionRepo.findOne({
        where: { id: project.current_session_id },
      });
      if (sess && sess.state !== 'archived') {
        sess.state = 'archived';
        await this.sessionRepo.save(sess);
      }
    }

    // 2) PRD·DESIGN 복원
    if (project.project_path) {
      await this.restoreDocsFromBackup(project.project_path);
    }

    // 3) current_session_id null + state → deployed
    await this.projectRepo.update(projectId, { current_session_id: null });
    await this.stateMachine.transition(
      projectId,
      'deployed',
      'user cancelled update cycle',
    );

    // 4) WS event로 프론트에 취소 알림
    this.gateway.emit({
      agent: 'planning',
      project_id: projectId,
      event_type: 'progress',
      phase: 'update_cycle_cancelled',
      payload: {
        detail: '업데이트 사이클을 취소하고 이전 상태로 돌아갔어요.',
      },
    });

    return { state: 'deployed' };
  }

  /**
   * backupDocsForUpdate로 만든 백업을 원본 위치로 복원. 성공 시 백업 제거.
   */
  private async restoreDocsFromBackup(projectPath: string): Promise<void> {
    const backupDir = path.join(projectPath, '.ax-build', 'pre-update-backup');
    try {
      await fs.access(backupDir);
    } catch {
      this.logger.warn(
        `restoreDocsFromBackup: no backup at ${backupDir}, skipping`,
      );
      return;
    }
    for (const name of ['PRD.md', 'DESIGN.md']) {
      const src = path.join(backupDir, name);
      const dst = path.join(projectPath, name);
      try {
        const content = await fs.readFile(src, 'utf8');
        await fs.writeFile(dst, content, 'utf8');
      } catch {
        /* file absent in backup — skip */
      }
    }
    try {
      await fs.rm(backupDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    this.logger.log(`pre-update docs restored from ${backupDir}`);
  }

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

    // 환각 감지 — 이번 턴의 실제 tool_call 횟수 카운트.
    if (event.event_type === 'tool_call') {
      const prev = this.turnToolCallCount.get(event.project_id) ?? 0;
      this.turnToolCallCount.set(event.project_id, prev + 1);
    }

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

    // evaluate_readiness — forward score to frontend for sidebar display.
    if (event.event_type === 'tool_result') {
      const trPayload = (event.payload ?? {}) as {
        name?: string;
        result?: {
          ok?: boolean;
          completeness?: Record<string, number>;
          score?: number;
          can_build?: boolean;
          summary?: string;
          label?: string;
        };
      };
      if (trPayload.name === 'evaluate_readiness' && trPayload.result?.ok) {
        this.gateway.emit({
          agent: 'planning',
          project_id: event.project_id,
          session_id: sessionId,
          event_type: 'progress',
          phase: 'readiness_update',
          payload: {
            completeness: trPayload.result.completeness,
            score: trPayload.result.score,
            can_build: trPayload.result.can_build,
            summary: trPayload.result.summary,
            label: trPayload.result.label,
          },
        });
      }
    }

    // propose_handoff notification — the Python tool writes the handoff row
    // and transitions projects.state directly via SQL; here we surface the
    // transition to the frontend so UI can flip to "빌드 시작" mode.
    //
    // ADR 0008: propose_handoff는 두 라인의 전이를 모두 담당:
    //   planning → plan_ready  (첫 빌드)
    //   planning_update → update_ready  (업데이트)
    //
    // [핵심] AI가 tool_result를 잘못 요약해 "이관 완료"라고 환각하는 사례가
    // 관찰됨 (회고 §5 유사 패턴). 이를 차단하기 위해 **결과와 무관하게** 도구
    // 호출 직후 전용 이벤트를 emit해 프론트가 확정적 배너를 표시하게 한다.
    // AI 텍스트 응답은 보조, 이 배너가 진실.
    //
    // 이벤트 phase:
    //   plan_ready / update_ready — accepted=true (전이됨)
    //   handoff_rejected          — accepted=false (거부됨)
    if (event.event_type === 'tool_result') {
      const payload = (event.payload ?? {}) as {
        name?: string;
        result?: {
          ok?: boolean;
          accepted?: boolean;
          transitioned_to_plan_ready?: boolean;
          transitioned_to_update_ready?: boolean;
          handoff_id?: string;
          min_completeness?: number;
          is_sufficient?: boolean;
          has_unresolved?: boolean;
          reason?: string | null;
          error?: string;
        };
      };
      const r = payload.result;
      if (payload.name === 'propose_handoff' && r) {
        if (r.ok === true) {
          const toPlanReady = r.transitioned_to_plan_ready === true;
          const toUpdateReady = r.transitioned_to_update_ready === true;
          if (toPlanReady || toUpdateReady) {
            const phase = toUpdateReady ? 'update_ready' : 'plan_ready';
            const detailPrefix = toUpdateReady ? '업데이트 준비 완료' : '빌드 준비 완료';
            this.gateway.emit({
              agent: 'planning',
              project_id: event.project_id,
              session_id: sessionId,
              event_type: 'progress',
              phase,
              progress_percent: 100,
              payload: {
                detail: r.is_sufficient
                  ? `충분 조건 충족 — ${detailPrefix}`
                  : `최소 조건 충족 — ${detailPrefix}`,
                handoff_id: r.handoff_id,
                min_completeness: r.min_completeness,
                is_sufficient: !!r.is_sufficient,
                accepted: true,
              },
            });
          } else {
            // 호출은 됐지만 accepted=false — 거부 이유와 함께 rejected 배너.
            this.gateway.emit({
              agent: 'planning',
              project_id: event.project_id,
              session_id: sessionId,
              event_type: 'progress',
              phase: 'handoff_rejected',
              payload: {
                detail: r.reason ?? '핸드오프 조건 미충족',
                min_completeness: r.min_completeness,
                is_sufficient: !!r.is_sufficient,
                has_unresolved: !!r.has_unresolved,
                accepted: false,
              },
            });
          }
        } else {
          // ok=false — 도구 내부 validation 실패 (PRD 없음 등).
          this.gateway.emit({
            agent: 'planning',
            project_id: event.project_id,
            session_id: sessionId,
            event_type: 'progress',
            phase: 'handoff_rejected',
            payload: {
              detail: r.error ?? '핸드오프 호출이 실패했습니다.',
              accepted: false,
            },
          });
        }
      }
    }

    if (event.event_type === 'completion') {
      const payload = (event.payload ?? {}) as { role?: string; content?: string };
      const content = typeof payload.content === 'string' ? payload.content : '';
      if (payload.role === 'assistant' && content.trim().length > 0) {
        await this.messageRepo.save(
          this.messageRepo.create({
            session_id: sessionId,
            role: 'assistant',
            content,
          }),
        );
      }

      // 환각 감지 (회고 §6/9) — AI가 텍스트로 "<tool_name> 도구를 호출합니다"
      // 류 문구를 쓰면서 이번 턴에 실제 tool_call을 한 번도 발사하지 않았으면
      // 유저에게 경고 배너. AI가 "호출하겠다"고 예고만 하고 실제 상태 전이가
      // 안 되는 가장 흔한 환각 패턴.
      const toolCallsThisTurn = this.turnToolCallCount.get(event.project_id) ?? 0;
      this.turnToolCallCount.delete(event.project_id);
      if (toolCallsThisTurn === 0 && content) {
        // 도구 이름 + 동작 동사가 근접 위치에 있는 텍스트만 환각 후보.
        // "도구 호출 시 주의" 같은 일반 문장은 매칭 안 되게 도구 이름 필수.
        const toolMentionPattern =
          /(write_prd|write_design|propose_handoff|evaluate_readiness|update_memory|search_memory)[\s\S]{0,40}(호출|실행|저장|제안|평가)/;
        if (toolMentionPattern.test(content)) {
          this.logger.warn(
            `Planning hallucination detected on project ${event.project_id}: ` +
            `AI mentioned tool call in text but no actual tool_call event fired.`,
          );
          this.gateway.emit({
            agent: 'planning',
            project_id: event.project_id,
            session_id: sessionId,
            event_type: 'progress',
            phase: 'hallucination_detected',
            payload: {
              detail:
                'AI가 도구를 호출한다고 말했지만 실제로는 호출되지 않았어요. 같은 요청을 한 번 더 보내거나 "AI에게 핸드오프 요청" 버튼을 눌러주세요.',
            },
          });
        }
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
