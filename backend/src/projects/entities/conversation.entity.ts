import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Project } from './project.entity.js';
import { User } from '../../auth/entities/user.entity.js';

export type ConversationType = 'scoring' | 'bug_report' | 'improvement';

@Entity('conversations')
export class Conversation {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36 })
  user_id!: string;

  @Column({
    type: 'enum',
    enum: ['scoring', 'bug_report', 'improvement'],
  })
  type!: ConversationType;

  @Column({ type: 'json' })
  conversation_history!: Array<{ role: string; content: string }>;

  @Column({ type: 'int', default: 0 })
  current_score!: number;

  @Column({ type: 'varchar', length: 30, default: 'too_vague' })
  score_tier!: string;

  @Column({ type: 'boolean', default: false })
  score_passed!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @ManyToOne(() => Project, (p) => p.conversations)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
