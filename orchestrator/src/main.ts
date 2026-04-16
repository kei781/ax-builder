import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: ['http://localhost:3123', 'https://hackathon.acaxiaa.store'],
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  const port = process.env['BACKEND_PORT'] || 4000;
  await app.listen(port);
  console.log(`ax-builder backend running on port ${port}`);
}

bootstrap();
