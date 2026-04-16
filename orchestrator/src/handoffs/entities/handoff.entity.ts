import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  Index,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Session } from '../../sessions/entities/session.entity.js';

/**
 * Handoff payload = the contract between Planning and Building.
 * One row per plan_ready transition (and per bounce-back retry).
 *
 * Schema: ARCHITECTURE.md §6.1
 */
@Entity('handoffs')
export class Handoff {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  session_id!: string;

  @Column({ type: 'varchar', length: 10 })
  schema_version!: string;

  @Column({ type: 'varchar', length: 500 })
  prd_snapshot_path!: string;

  @Column({ type: 'varchar', length: 500 })
  design_snapshot_path!: string;

  /** 5 dimensions, each 0.0 - 1.0. Keys match the scoring UI labels. */
  @Column({ type: 'simple-json' })
  completeness!: {
    problem_definition: number;
    feature_list: number;
    user_flow: number;
    feasibility: number;
    user_experience: number;
  };

  /** Must be empty to allow handoff. Non-empty = needs user clarification. */
  @Column({ type: 'simple-json' })
  unresolved_questions!: string[];

  /** Decisions Planning Agent made unilaterally; shown to user for review. */
  @Column({ type: 'simple-json' })
  assumptions_made!: string[];

  /** Hard constraints Building must obey. */
  @Column({ type: 'simple-json' })
  tech_constraints!: Record<string, string>;

  @CreateDateColumn()
  created_at!: Date;

  @ManyToOne(() => Session)
  @JoinColumn({ name: 'session_id' })
  session!: Session;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
