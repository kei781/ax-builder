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

  /**
   * ADR 0008 §D7 — QA가 빌드 시점에 응답 확인한 primary endpoint 리스트 (JSON).
   * 이후 업데이트 QA에서 regression 기준으로 사용 — 이 리스트의 엔드포인트가
   * 업데이트 후에도 여전히 응답해야 deployment 승인.
   * null이면 regression 검사 건너뜀(레거시 버전).
   */
  @Column({ type: 'simple-json', nullable: true })
  primary_endpoints!: string[] | null;

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
