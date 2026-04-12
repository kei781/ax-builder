import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback, Profile } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service.js';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    const clientID = configService.get<string>('GOOGLE_CLIENT_ID', '');
    const clientSecret = configService.get<string>('GOOGLE_CLIENT_SECRET', '');
    const callbackURL = configService.get<string>(
      'GOOGLE_CALLBACK_URL',
      'http://localhost:3123/api/auth/google/callback',
    );

    super({
      clientID,
      clientSecret,
      callbackURL,
      scope: ['email', 'profile'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<void> {
    const email = profile.emails?.[0]?.value;

    if (!email) {
      // false + info → AuthGuard가 예외 대신 req.authInfo에 담아줌
      done(null, false, { message: 'no_email' });
      return;
    }

    // Domain check
    const allowedDomain = this.configService.get<string>('ALLOWED_EMAIL_DOMAIN', 'cv-3.com');
    if (!email.endsWith(`@${allowedDomain}`)) {
      done(null, false, { message: 'domain_invalid' });
      return;
    }

    const user = await this.authService.validateOAuthUser({
      email,
      name: profile.displayName || email.split('@')[0],
      avatar_url: profile.photos?.[0]?.value || null,
    });

    done(null, user);
  }
}
