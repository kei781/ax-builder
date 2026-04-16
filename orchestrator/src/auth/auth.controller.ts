import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { User } from './entities/user.entity.js';

class GoogleCallbackGuard extends AuthGuard('google') {
  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      return {
        _authFailed: true,
        reason: info?.message || 'auth_failed',
        email: info?.email || '',
        name: info?.name || '',
      };
    }
    return user;
  }
}

@Controller('auth')
export class AuthController {
  private readonly frontendUrl: string;

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {
    this.frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3123',
    );
  }

  @Get('google')
  @UseGuards(AuthGuard('google'))
  googleAuth() {}

  @Get('google/callback')
  @UseGuards(GoogleCallbackGuard)
  googleAuthCallback(
    @Req() req: Record<string, any>,
    @Res() res: Record<string, any>,
  ) {
    const response = res as unknown as Response;
    const user = req['user'];

    if (!user || user._authFailed) {
      const reason = user?.reason || 'auth_failed';
      const params = new URLSearchParams({ error: reason });
      if (user?.email) params.set('email', user.email);
      if (user?.name) params.set('name', user.name);
      response.redirect(`${this.frontendUrl}/login?${params.toString()}`);
      return;
    }

    const token = this.authService.generateJwt(user as User);
    response.redirect(`${this.frontendUrl}/login?token=${token}`);
  }

  /** 사용 신청서 제출 (public) */
  @Post('access-request')
  async submitAccessRequest(
    @Body() body: { email?: string; name?: string; organization?: string },
  ) {
    const { email, name, organization } = body;
    if (!email || !name || !organization) {
      throw new BadRequestException('이메일, 성함, 소속은 필수입니다.');
    }
    await this.authService.createAccessRequest(email, name, organization);
    return { message: '사용 신청이 접수되었습니다. 승인 후 이메일로 안내됩니다.' };
  }

  /** 승인 링크 처리 (public, 메일에서 클릭) */
  @Get('approve/:token')
  async approveRequest(
    @Param('token') token: string,
    @Res() res: Record<string, any>,
  ) {
    const response = res as unknown as Response;
    try {
      const request = await this.authService.approveRequest(token);
      response.send(`
        <html>
        <head><meta charset="utf-8"><title>승인 완료</title></head>
        <body style="font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb;">
          <div style="text-align: center; padding: 40px; background: white; border-radius: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); max-width: 400px;">
            <div style="font-size: 48px; margin-bottom: 16px;">✅</div>
            <h1 style="font-size: 20px; color: #111; margin: 0 0 8px;">${request.name}님의 사용이 승인되었습니다</h1>
            <p style="color: #666; font-size: 14px; margin: 0;">${request.email}으로 승인 안내 메일이 발송되었습니다.</p>
          </div>
        </body>
        </html>
      `);
    } catch {
      response.status(400).send(`
        <html>
        <head><meta charset="utf-8"><title>승인 실패</title></head>
        <body style="font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f9fafb;">
          <div style="text-align: center; padding: 40px; background: white; border-radius: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); max-width: 400px;">
            <div style="font-size: 48px; margin-bottom: 16px;">❌</div>
            <h1 style="font-size: 20px; color: #111; margin: 0 0 8px;">유효하지 않은 승인 링크입니다</h1>
            <p style="color: #666; font-size: 14px; margin: 0;">링크가 만료되었거나 이미 처리되었습니다.</p>
          </div>
        </body>
        </html>
      `);
    }
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Req() req: Record<string, any>) {
    const payload = req['user'] as { id: string; email: string } | undefined;
    if (!payload) {
      throw new UnauthorizedException();
    }

    const user = await this.authService.findById(payload.id);
    if (!user) {
      throw new UnauthorizedException();
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url,
    };
  }
}
