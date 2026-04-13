import {
  Controller,
  Get,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
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
      return { _authFailed: true, reason: info?.message || 'auth_failed' };
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
      response.redirect(`${this.frontendUrl}/login?error=${reason}`);
      return;
    }

    const token = this.authService.generateJwt(user as User);
    response.redirect(`${this.frontendUrl}/login?token=${token}`);
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
