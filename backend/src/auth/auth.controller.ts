import {
  Controller,
  Get,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { User } from './entities/user.entity.js';

// Google callback guard — 실패해도 예외 대신 req.user = false 전달
class GoogleCallbackGuard extends AuthGuard('google') {
  handleRequest(err: any, user: any, info: any) {
    // 에러나 user=false여도 예외 안 던지고 그대로 넘김
    if (err || !user) {
      return { _authFailed: true, reason: info?.message || 'auth_failed' };
    }
    return user;
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('google')
  @UseGuards(AuthGuard('google'))
  googleAuth() {
    // Initiates Google OAuth flow
  }

  @Get('google/callback')
  @UseGuards(GoogleCallbackGuard)
  googleAuthCallback(
    @Req() req: Record<string, any>,
    @Res() res: Record<string, any>,
  ) {
    const response = res as unknown as Response;
    const user = req['user'];

    // 인증 실패 시 프론트엔드 로그인 페이지로 리다이렉트 (에러 코드 포함)
    if (!user || user._authFailed) {
      const reason = user?.reason || 'auth_failed';
      response.redirect(`http://localhost:5173/login?error=${reason}`);
      return;
    }

    const token = this.authService.generateJwt(user as User);
    response.redirect(`http://localhost:5173/login?token=${token}`);
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
