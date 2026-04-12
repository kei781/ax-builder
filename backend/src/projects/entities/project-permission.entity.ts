import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  Unique,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Project } from './project.entity.js';
import { User } from '../../auth/entities/user.entity.js';

export type PermissionRole = 'owner' | 'editor' | 'viewer';

@Entity('project_permissions')
@Unique(['project_id', 'user_id'])
export class ProjectPermission {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 36 })
  user_id!: string;

  @Column({
    type: 'enum',
    enum: ['owner', 'editor', 'viewer'],
    default: 'viewer',
  })
  role!: PermissionRole;

  @Column({ type: 'varchar', length: 36 })
  granted_by!: string;

  @CreateDateColumn()
  created_at!: Date;

  @ManyToOne(() => Project, (p) => p.permissions)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'granted_by' })
  granter!: User;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
