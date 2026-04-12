import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { User } from './entities/user.entity.js';

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
    private readonly jwtService: JwtService,
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
}
