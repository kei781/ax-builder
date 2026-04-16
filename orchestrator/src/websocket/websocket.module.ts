import { Module } from '@nestjs/common';
import { BuildGateway } from './build.gateway.js';

@Module({
  providers: [BuildGateway],
  exports: [BuildGateway],
})
export class WebsocketModule {}
