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
import { Build } from './build.entity.js';

export type BuildPhaseStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped';

/**
 * A single phase in a Building run. Phase names come from Hermes's dynamic
 * PHASES.md generator (ARCHITECTURE §4.1, Q1=(b)). Phase lifecycle is
 * isolated — one Claude CLI invocation per phase (Q2=(β)).
 */
@Entity('build_phases')
export class BuildPhase {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  build_id!: string;

  @Column({ type: 'int' })
  idx!: number;

  @Column({ type: 'varchar', length: 64 })
  name!: string;

  @Column({ type: 'varchar', length: 10, default: 'pending' })
  status!: BuildPhaseStatus;

  /** Full prompt sent to Claude CLI for this phase (audit/replay). */
  @Column({ type: 'text', nullable: true })
  input_prompt!: string | null;

  /** Claude CLI stdout/stderr captured for this phase. */
  @Column({ type: 'text', nullable: true })
  output_log!: string | null;

  @CreateDateColumn()
  started_at!: Date;

  @Column({ type: 'datetime', nullable: true })
  finished_at!: Date | null;

  @ManyToOne(() => Build, (b) => b.phases)
  @JoinColumn({ name: 'build_id' })
  build!: Build;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
