import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  Index,
  Unique,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Project } from '../../projects/entities/project.entity.js';

/**
 * One row per successful deploy. Version numbers are monotonic per-project.
 * Each row retains the git commit SHA and deployed container ID so that
 * rollback (modification failure → restore previous version) is trivial.
 */
@Entity('project_versions')
@Unique(['project_id', 'version'])
export class ProjectVersion {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  project_id!: string;

  @Column({ type: 'int' })
  version!: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  git_repo_url!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  git_commit!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  container_id!: string | null;

  @CreateDateColumn()
  deployed_at!: Date;

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
