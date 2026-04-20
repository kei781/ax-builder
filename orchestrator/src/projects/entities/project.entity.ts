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
 * 두 개의 라인이 존재합니다(ADR 0008):
 *
 *   [첫 빌드 라인]
 *     draft → planning → plan_ready → building → qa → env_qa → deployed
 *                ↑                       │
 *                └──── bounce-back ──────┘
 *
 *   [업데이트 라인]
 *     deployed → planning_update → update_ready → updating → update_qa → deployed
 *                      ↑                             │            │
 *                      └──── rollback / bounce ──────┴────────────┘
 *
 *   * → failed  (lock, fatal error, 또는 운영자 개입 필요한 infra_error)
 */
export type ProjectState =
  // 첫 빌드 라인
  | 'draft'
  | 'planning'
  | 'plan_ready'
  | 'building'
  | 'qa'
  // env 사이드 (양 라인 공유)
  | 'awaiting_env'
  | 'env_qa'
  // 터미널
  | 'deployed'
  | 'failed'
  // 업데이트 라인
  | 'planning_update'
  | 'update_ready'
  | 'updating'
  | 'update_qa';

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

  /**
   * ADR 0008 §D4 — update 시작 직전의 container_id 백업.
   * `updating`/`update_qa` 실패 시 복구 대상. 성공하면 clear.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  previous_container_id!: string | null;

  /**
   * ADR 0008 §D4 — update 시작 직전의 current_version 백업.
   * 롤백 시 `current_version`과 `container_id`를 되돌리는 데 쓰임.
   */
  @Column({ type: 'int', nullable: true })
  previous_version!: number | null;

  /** Lock expiry (H1: nonsense-input lock). Counts toward owner's planning quota. */
  @Column({ type: 'datetime', nullable: true })
  locked_until!: Date | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  lock_reason!: string | null;

  /**
   * ADR 0002 — env_qa 실패 누적 카운터. `env_rejected`로 분류된 실패 한정.
   * 3회 도달 시 schema_bug로 에스컬레이트 → Planning bounce. 성공 시 0 리셋.
   */
  @Column({ type: 'int', default: 0 })
  env_attempts!: number;

  /**
   * Phase 6 / ADR 0003 — AI Gateway 프로젝트 토큰의 SHA-256 hex 해시.
   * 평문 토큰은 project_env_vars에 AX_AI_TOKEN(system-injected)로 암호화 저장.
   * 이 해시는 Gateway HTTP 인증(Authorization: Bearer ...) 역조회용.
   * revoke하려면 NULL로 비우면 됨.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  @Index()
  ai_token_hash!: string | null;

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
