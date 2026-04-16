import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

export type AccessRequestStatus = 'pending' | 'approved' | 'rejected';

@Entity('access_requests')
export class AccessRequest {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 200 })
  organization!: string;

  @Column({ type: 'varchar', length: 10, default: 'pending' })
  status!: AccessRequestStatus;

  @Column({ type: 'varchar', length: 36, unique: true })
  token!: string;

  @CreateDateColumn()
  created_at!: Date;

  @BeforeInsert()
  generateIds() {
    if (!this.id) this.id = uuidv4();
    if (!this.token) this.token = uuidv4();
  }
}
