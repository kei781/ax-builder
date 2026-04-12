import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Project } from '../../projects/entities/project.entity.js';

export type BuildPhase = 'build' | 'qa' | 'deploy';
export type BuildStatus = 'running' | 'success' | 'failed';

@Entity('build_logs')
export class BuildLog {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'int' })
  attempt!: number;

  @Column({ type: 'varchar', length: 10 })
  phase!: BuildPhase;

  @Column({ type: 'varchar', length: 10 })
  status!: BuildStatus;

  @Column({ type: 'text', nullable: true })
  log_output!: string | null;

  @Column({ type: 'text', nullable: true })
  error_message!: string | null;

  @CreateDateColumn()
  started_at!: Date;

  @Column({ type: 'datetime', nullable: true })
  finished_at!: Date | null;

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
