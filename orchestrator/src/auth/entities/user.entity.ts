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

  /**
   * 플랫폼 관리자. 설정된 `ADMIN_EMAILS` 환경변수에 이메일이 포함되면
   * 로그인 시 자동 true가 된다. admin은:
   *   - 모든 프로젝트에 owner 권한으로 접근 가능 (채팅·빌드·env·삭제)
   *   - findAllForUser / findPublicList에서 전체 프로젝트를 본다
   *   - ProjectPermissionsGuard / ChatService.requireMembership 우회
   * JWT payload에도 포함돼 O(1) 체크 가능.
   */
  @Column({ type: 'boolean', default: false })
  is_admin!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }
}
