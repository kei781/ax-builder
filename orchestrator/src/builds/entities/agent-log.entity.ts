import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  BeforeInsert,
  Index,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

export type AgentSource = 'planning' | 'building' | 'claude';

/**
 * Flat audit log for agent events.
 *
 * Per ARCHITECTURE §13.1, we retain raw prompts/responses — the DB lives on
 * a separate 4TB machine so disk pressure is not a constraint. This table
 * grows fast but is append-only, which is cheap.
 */
@Entity('agent_logs')
export class AgentLog {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  project_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  session_id!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  build_id!: string | null;

  @Column({ type: 'varchar', length: 15 })
  @Index()
  agent!: AgentSource;

  @Column({ type: 'varchar', length: 40 })
  event_type!: string;

  @Column({ type: 'simple-json' })
  payload!: unknown;

  @CreateDateColumn()
  created_at!: Date;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
