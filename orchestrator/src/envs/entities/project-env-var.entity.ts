import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  BeforeInsert,
  Unique,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

/** Env tier. See PRD §9.1.1 and ADR 0004. */
export type EnvTier = 'system-injected' | 'user-required' | 'user-optional';

/**
 * One parsed variable from the project's .env.example, optionally with a
 * user-submitted (or system-generated) value.
 *
 * Values are AES-256-GCM encrypted before persistence. `value_ciphertext`
 * is the payload returned by EnvCryptoService; null means "not yet set"
 * (for user-required tier this blocks deploy).
 */
@Entity('project_env_vars')
@Unique(['project_id', 'key'])
export class ProjectEnvVar {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  project_id!: string;

  @Column({ type: 'varchar', length: 255 })
  key!: string;

  /** `system-injected` | `user-required` | `user-optional` */
  @Column({ type: 'varchar', length: 32 })
  tier!: EnvTier;

  /** AES-256-GCM ciphertext (base64). Null = not set. */
  @Column({ type: 'text', nullable: true })
  value_ciphertext!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  issuance_guide!: string | null;

  @Column({ type: 'text', nullable: true })
  example!: string | null;

  /** Per §9.2 — `required` or `optional` (orthogonal to tier; user-required is both required and user-tier). */
  @Column({ type: 'boolean', default: true })
  required!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @BeforeInsert()
  generateId() {
    if (!this.id) this.id = uuidv4();
  }
}
