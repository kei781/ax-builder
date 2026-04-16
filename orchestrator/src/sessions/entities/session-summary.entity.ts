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

/**
 * Cumulative summaries of older conversation turns.
 *
 * Generated on (N tokens OR 50 turns OR 30min idle) — see ARCHITECTURE §5.3.
 * `covers_start` / `covers_end` reference conversation_messages.id bounds
 * so we can detect which turns have been compressed.
 */
@Entity('session_summaries')
export class SessionSummary {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  session_id!: string;

  @Column({ type: 'text' })
  summary_text!: string;

  @Column({ type: 'varchar', length: 36 })
  covers_start_message_id!: string;

  @Column({ type: 'varchar', length: 36 })
  covers_end_message_id!: string;

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
