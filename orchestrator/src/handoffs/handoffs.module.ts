import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Handoff } from './entities/handoff.entity.js';
import { HandoffsService } from './handoffs.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Handoff])],
  providers: [HandoffsService],
  exports: [HandoffsService],
})
export class HandoffsModule {}
