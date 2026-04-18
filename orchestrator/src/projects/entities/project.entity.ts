import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  BeforeInsert,
  Index,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../../auth/entities/user.entity.js';
import { ProjectPermission } from './project-permission.entity.js';

/**
 * Project lifecycle state machine.
 *
 * Transitions (see ARCHITECTURE.md §7):
 *   draft → planning → plan_ready → building → qa → deployed
 *              ↑                       │
 *              └──── bounce-back ──────┘
 *   deployed → modifying  (new session for edits)
 *   * → failed            (lock or fatal error)
 */
export type ProjectState =
  | 'draft'
  | 'planning'
  | 'plan_ready'
  | 'building'
  | 'qa'
  | 'awaiting_env'
  | 'env_qa'
  | 'deployed'
  | 'failed'
  | 'modifying';

@Entity('projects')
export class Project {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  owner_id!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  @Index()
  state!: ProjectState;

  /** Active planning/modifying session (FK to sessions.id). Null during idle or archived. */
  @Column({ type: 'varchar', length: 36, nullable: true })
  current_session_id!: string | null;

  /** Incremented on every successful deploy; mirrors project_versions.version. */
  @Column({ type: 'int', default: 0 })
  current_version!: number;

  /** Filesystem path on orchestrator host. Populated when draft → planning. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  project_path!: string | null;

  /** Port of the currently deployed container. */
  @Column({ type: 'int', nullable: true })
  port!: number | null;

  /** ID of the currently deployed container. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  container_id!: string | null;

  /** Lock expiry (H1: nonsense-input lock). Counts toward owner's planning quota. */
  @Column({ type: 'datetime', nullable: true })
  locked_until!: Date | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  lock_reason!: string | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'owner_id' })
  owner!: User;

  @OneToMany(() => ProjectPermission, (p) => p.project)
  permissions!: ProjectPermission[];

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
