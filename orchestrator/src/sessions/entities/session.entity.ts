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
import { Project } from '../../projects/entities/project.entity.js';

/**
 * Session lifecycle (ARCHITECTURE §5.4, §8.4):
 *   active    — planning/modifying in progress
 *   suspended — 30min idle; memory unloaded but row preserved
 *   archived  — build completed successfully; a new session starts for edits
 */
export type SessionState = 'active' | 'suspended' | 'archived';

/**
 * Session = one conversation lifecycle tied to a project.
 * Spans draft → planning → plan_ready → building → deployed.
 * On successful deploy, this session is archived and any subsequent
 * modification request starts a new Session row.
 */
@Entity('sessions')
export class Session {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  project_id!: string;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  @Index()
  state!: SessionState;

  /** Last DB checkpoint write (A1: 10min interval). */
  @Column({ type: 'datetime', nullable: true })
  last_checkpoint_at!: Date | null;

  /** Last user/agent activity (used to trigger 30min unload). */
  @Column({ type: 'datetime', nullable: true })
  last_activity_at!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  suspended_at!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  archived_at!: Date | null;

  @CreateDateColumn()
  created_at!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
