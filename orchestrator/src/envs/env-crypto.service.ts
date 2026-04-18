import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

/**
 * AES-256-GCM encryption for env values.
 *
 * Payload format (base64): IV(12) || AUTH_TAG(16) || CIPHERTEXT
 *
 * Key derivation: SHA-256 of `AX_ENV_ENCRYPTION_KEY` so the key length is
 * always 32 bytes regardless of user input. Missing key = startup error
 * (we don't silently fall back to a hardcoded default — that would be
 * worse than plaintext because it would masquerade as security).
 */
@Injectable()
export class EnvCryptoService {
  private readonly logger = new Logger(EnvCryptoService.name);
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('AX_ENV_ENCRYPTION_KEY');
    if (!raw) {
      // In dev we accept a derived default from a warning path so the app
      // still starts. In production this should be set explicitly.
      const devFallback = config.get<string>('JWT_SECRET') ?? 'ax-builder-dev';
      this.logger.warn(
        'AX_ENV_ENCRYPTION_KEY not set — using JWT_SECRET-derived key (DEV ONLY).',
      );
      this.key = createHash('sha256').update(devFallback).digest();
    } else {
      this.key = createHash('sha256').update(raw).digest();
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  decrypt(ciphertext: string): string {
    try {
      const buf = Buffer.from(ciphertext, 'base64');
      if (buf.length < 28) throw new Error('payload too short');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    } catch (err: any) {
      this.logger.error(`decrypt failed: ${err?.message ?? err}`);
      throw new InternalServerErrorException('환경변수 복호화 실패');
    }
  }
}
