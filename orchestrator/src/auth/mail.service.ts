import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { AccessRequest } from './entities/access-request.entity.js';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly fromEmail: string;
  private readonly ownerEmail: string;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    const gmailUser = config.get<string>('GMAIL_USER', '');
    const gmailPass = config.get<string>('GMAIL_APP_PASSWORD', '');

    this.fromEmail = gmailUser;
    this.ownerEmail = config.get<string>('OWNER_EMAIL', '');
    this.baseUrl = config.get<string>('FRONTEND_URL', 'http://localhost:3123');

    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    });
  }

  /** 제품 주인에게 승인 요청 메일 */
  async sendApprovalRequest(request: AccessRequest): Promise<void> {
    if (!this.ownerEmail) {
      this.logger.warn('OWNER_EMAIL not set, skipping approval request mail');
      return;
    }

    // 백엔드 API URL (프론트 URL과 다를 수 있으므로 /api prefix 사용)
    const approveUrl = `${this.baseUrl}/api/auth/approve/${request.token}`;

    await this.transporter.sendMail({
      from: `ax-builder <${this.fromEmail}>`,
      to: this.ownerEmail,
      subject: `[ax-builder] 사용 신청: ${request.name} (${request.organization})`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
          <h2 style="margin: 0 0 20px; font-size: 20px; color: #111;">새로운 사용 신청</h2>
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
            <tr><td style="padding: 8px 0; color: #666; width: 80px;">성함</td><td style="padding: 8px 0; color: #111; font-weight: 500;">${request.name}</td></tr>
            <tr><td style="padding: 8px 0; color: #666;">소속</td><td style="padding: 8px 0; color: #111; font-weight: 500;">${request.organization}</td></tr>
            <tr><td style="padding: 8px 0; color: #666;">이메일</td><td style="padding: 8px 0; color: #111; font-weight: 500;">${request.email}</td></tr>
          </table>
          <a href="${approveUrl}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
            승인하기
          </a>
          <p style="margin-top: 16px; font-size: 12px; color: #999;">이 링크를 클릭하면 해당 사용자가 ax-builder에 접근할 수 있게 됩니다.</p>
        </div>
      `,
    });

    this.logger.log(`Approval request email sent to ${this.ownerEmail} for ${request.email}`);
  }

  /** 신청자에게 승인 완료 메일 */
  async sendApprovalNotification(email: string, name: string): Promise<void> {
    const loginUrl = `${this.baseUrl}/login`;

    await this.transporter.sendMail({
      from: `ax-builder <${this.fromEmail}>`,
      to: email,
      subject: '[ax-builder] 사용 신청이 승인되었습니다',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
          <h2 style="margin: 0 0 16px; font-size: 20px; color: #111;">사용 승인 완료</h2>
          <p style="color: #333; line-height: 1.6;">
            안녕하세요 ${name}님,<br/>
            ax-builder 사용 신청이 승인되었습니다. 이제 Google 로그인으로 접속하실 수 있습니다.
          </p>
          <a href="${loginUrl}" style="display: inline-block; margin-top: 16px; background: #16a34a; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">
            로그인하기
          </a>
        </div>
      `,
    });

    this.logger.log(`Approval notification sent to ${email}`);
  }
}
