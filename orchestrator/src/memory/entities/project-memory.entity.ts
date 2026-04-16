import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  Unique,
  Index,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Project } from '../../projects/entities/project.entity.js';

/**
 * Key-value memory scoped to a project.
 *
 * Used by Planning Agent's `search_memory` / `update_memory` tools
 * (ARCHITECTURE §3.3, §5.1). Entries are freeform — the agent decides
 * what keys matter.
 */
@Entity('project_memory')
@Unique(['project_id', 'key'])
export class ProjectMemory {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  project_id!: string;

  @Column({ type: 'varchar', length: 100 })
  key!: string;

  @Column({ type: 'simple-json' })
  value!: unknown;

  @UpdateDateColumn()
  updated_at!: Date;

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
