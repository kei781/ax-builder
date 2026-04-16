import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Handoff } from './entities/handoff.entity.js';

/**
 * Handoff persistence + readiness checks.
 *
 * Rows are inserted directly by the Planning Agent's `propose_handoff` tool
 * (Python, same SQLite file, WAL mode). This service reads them back and
 * enforces the build-gate invariants from ARCHITECTURE.md §6.
 */
@Injectable()
export class HandoffsService {
  private readonly logger = new Logger(HandoffsService.name);

  constructor(
    @InjectRepository(Handoff)
    private readonly handoffRepo: Repository<Handoff>,
  ) {}

  async latestForSession(sessionId: string): Promise<Handoff | null> {
    return this.handoffRepo.findOne({
      where: { session_id: sessionId },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Minimum completeness threshold — every category ≥ 0.6. Kept in sync with
   * the Python side's MIN_COMPLETENESS constant in
   * planning-agent/app/agent/tools/propose_handoff.py.
   */
  private meetsMinimumCompleteness(handoff: Handoff): boolean {
    const values = Object.values(handoff.completeness);
    return values.length > 0 && values.every((v) => v >= 0.6);
  }

  /**
   * Build-gate check: `plan_ready → building` requires this to be true.
   * Minimum completeness + no unresolved questions.
   */
  isReadyForBuild(handoff: Handoff): boolean {
    return (
      this.meetsMinimumCompleteness(handoff) &&
      handoff.unresolved_questions.length === 0
    );
  }

  /**
   * UI decoration — "충분 조건 충족" label (every category ≥ 0.85).
   * Does not gate the transition; the user can still build at 0.6.
   */
  isSufficient(handoff: Handoff): boolean {
    const values = Object.values(handoff.completeness);
    return values.length > 0 && values.every((v) => v >= 0.85);
  }
}
