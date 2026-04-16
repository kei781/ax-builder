import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  BeforeInsert,
  Index,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Project } from '../../projects/entities/project.entity.js';
import { Session } from '../../sessions/entities/session.entity.js';
import { BuildPhase } from './build-phase.entity.js';

export type BuildStatus =
  | 'running'
  | 'bounced'   // Building → Planning bounce-back
  | 'success'
  | 'failed'
  | 'cancelled';

/**
 * One Building Agent run. One session can have multiple builds (bounce-back
 * creates a new one on retry).
 */
@Entity('builds')
export class Build {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  project_id!: string;

  @Column({ type: 'varchar', length: 36 })
  session_id!: string;

  @Column({ type: 'int' })
  version!: number;

  @Column({ type: 'varchar', length: 15, default: 'running' })
  @Index()
  status!: BuildStatus;

  /** Filesystem path to the dynamically-generated PHASES.md for this build. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  phases_md_path!: string | null;

  /**
   * Structured gap list the Hermes layer produces when bouncing back.
   * Fed back into Planning Agent to guide the next conversation round.
   */
  @Column({ type: 'simple-json', nullable: true })
  bounce_reason_gap_list!: string[] | null;

  @CreateDateColumn()
  started_at!: Date;

  @Column({ type: 'datetime', nullable: true })
  finished_at!: Date | null;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => Session)
  @JoinColumn({ name: 'session_id' })
  session!: Session;

  @OneToMany(() => BuildPhase, (p) => p.build)
  phases!: BuildPhase[];

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
