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
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../../auth/entities/user.entity.js';
import { Conversation } from './conversation.entity.js';
import { ProjectPermission } from './project-permission.entity.js';
import { ProjectEnvVar } from './project-env-var.entity.js';

export type ProjectStatus =
  | 'scoring'
  | 'building'
  | 'qa'
  | 'awaiting_env'
  | 'deployed'
  | 'failed'
  | 'stopped';

@Entity('projects')
export class Project {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  user_id!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'varchar', length: 20, default: 'scoring' })
  status!: ProjectStatus;

  @Column({ type: 'int', default: 0 })
  score!: number;

  @Column({ type: 'int', nullable: true })
  port!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  container_id!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  prd_path!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  project_path!: string | null;

  @Column({ type: 'text', nullable: true })
  prd_content!: string | null;

  @Column({ type: 'text', nullable: true })
  design_content!: string | null;

  @Column({ type: 'text', nullable: true })
  prototype_html!: string | null;

  @Column({ type: 'int', default: 0 })
  build_attempts!: number;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @OneToMany(() => Conversation, (c) => c.project)
  conversations!: Conversation[];

  @OneToMany(() => ProjectPermission, (p) => p.project)
  permissions!: ProjectPermission[];

  @OneToMany(() => ProjectEnvVar, (e) => e.project)
  env_vars!: ProjectEnvVar[];

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
