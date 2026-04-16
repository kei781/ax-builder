import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

@Entity('users')
export class User {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  avatar_url!: string | null;

  // Profile fields consumed by Planning Agent memory scope (ARCHITECTURE §5.1).
  // Set at signup, editable on the profile page. Static properties only —
  // the agent never learns these implicitly from conversation.

  @Column({ type: 'boolean', default: false })
  profile_is_developer!: boolean;

  @Column({ type: 'varchar', length: 10, default: 'detailed' })
  profile_explain_depth!: 'brief' | 'detailed';

  @CreateDateColumn()
  created_at!: Date;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
