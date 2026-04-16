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
import { Session } from './session.entity.js';

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

/**
 * Every message exchanged in a session.
 *
 * Per ARCHITECTURE §13.1, raw prompts/responses are stored in full
 * (privacy yields to logging/debugging priorities).
 */
@Entity('conversation_messages')
export class ConversationMessage {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  session_id!: string;

  @Column({ type: 'varchar', length: 10 })
  role!: MessageRole;

  @Column({ type: 'text', nullable: true })
  content!: string | null;

  // Populated when role = 'tool' or when assistant issued a tool call.
  @Column({ type: 'varchar', length: 64, nullable: true })
  tool_name!: string | null;

  @Column({ type: 'simple-json', nullable: true })
  tool_args!: Record<string, unknown> | null;

  @Column({ type: 'simple-json', nullable: true })
  tool_result!: unknown | null;

  /**
   * User who authored this message (role = 'user').
   * UI display only — the agent does not differentiate speakers
   * within a project (ARCHITECTURE §9.4).
   */
  @Column({ type: 'varchar', length: 36, nullable: true })
  author_user_id!: string | null;

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
