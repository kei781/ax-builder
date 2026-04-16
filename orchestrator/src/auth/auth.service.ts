import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { User } from './entities/user.entity.js';
import { AccessRequest } from './entities/access-request.entity.js';
import { MailService } from './mail.service.js';

interface OAuthUserData {
  email: string;
  name: string;
  avatar_url: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(AccessRequest)
    private readonly accessRequestRepo: Repository<AccessRequest>,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
  ) {}

  async validateOAuthUser(data: OAuthUserData): Promise<User> {
    let user = await this.userRepo.findOne({ where: { email: data.email } });

    if (!user) {
      user = this.userRepo.create({
        email: data.email,
        name: data.name,
        avatar_url: data.avatar_url,
      });
      user = await this.userRepo.save(user);
    } else {
      // Update name and avatar on each login
      user.name = data.name;
      user.avatar_url = data.avatar_url;
      user = await this.userRepo.save(user);
    }

    return user;
  }

  generateJwt(user: User): string {
    const payload = { sub: user.id, email: user.email };
    return this.jwtService.sign(payload);
  }

  async findById(id: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { id } });
  }

  /** 승인된 사용자인지 확인 (AccessRequest approved OR 이미 User 존재) */
  async isApprovedUser(email: string): Promise<boolean> {
    const user = await this.userRepo.findOne({ where: { email } });
    if (user) return true;

    const approved = await this.accessRequestRepo.findOne({
      where: { email, status: 'approved' },
    });
    return !!approved;
  }

  /** 사용 신청서 생성 + 주인에게 메일 발송 */
  async createAccessRequest(
    email: string,
    name: string,
    organization: string,
  ): Promise<AccessRequest> {
    // 이미 pending 신청이 있으면 중복 방지
    const existing = await this.accessRequestRepo.findOne({
      where: { email, status: 'pending' },
    });
    if (existing) {
      throw new ConflictException('이미 승인 대기 중인 신청이 있습니다.');
    }

    // 이미 승인됨
    const approved = await this.accessRequestRepo.findOne({
      where: { email, status: 'approved' },
    });
    if (approved) {
      throw new ConflictException('이미 승인된 사용자입니다. 다시 로그인해주세요.');
    }

    const request = this.accessRequestRepo.create({ email, name, organization });
    const saved = await this.accessRequestRepo.save(request);

    await this.mailService.sendApprovalRequest(saved);
    return saved;
  }

  /** 승인 토큰으로 신청 승인 처리 */
  async approveRequest(token: string): Promise<AccessRequest> {
    const request = await this.accessRequestRepo.findOne({ where: { token } });
    if (!request) {
      throw new NotFoundException('유효하지 않은 승인 링크입니다.');
    }
    if (request.status === 'approved') {
      return request; // 이미 승인됨
    }

    request.status = 'approved';
    await this.accessRequestRepo.save(request);

    // 승인 알림 메일 발송
    await this.mailService.sendApprovalNotification(request.email, request.name);

    return request;
  }
}
