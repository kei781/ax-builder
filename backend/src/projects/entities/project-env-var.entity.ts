import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  Unique,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Project } from './project.entity.js';

@Entity('project_env_vars')
@Unique(['project_id', 'key_name'])
export class ProjectEnvVar {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  project_id!: string;

  @Column({ type: 'varchar', length: 255 })
  key_name!: string;

  @Column({ type: 'text', nullable: true })
  encrypted_value!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  how_to_obtain!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  example_value!: string | null;

  @Column({ type: 'boolean', default: true })
  is_required!: boolean;

  @Column({ type: 'boolean', default: false })
  is_filled!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @ManyToOne(() => Project, (p) => p.env_vars)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
