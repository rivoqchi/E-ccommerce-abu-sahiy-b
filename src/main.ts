import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import compression from 'compression';
import { join } from 'path';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const config = app.get(ConfigService);

  const prefix = config.get<string>('apiPrefix', 'api/v1');
  app.setGlobalPrefix(prefix, {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'ping', method: RequestMethod.GET },
    ],
  });

  // Base64 image uploads exceed Express default 100kb JSON limit
  app.useBodyParser('json', { limit: '24mb' });
  app.useBodyParser('urlencoded', { limit: '24mb', extended: true });

  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads/',
  });

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(compression());

  const corsOrigin = config.getOrThrow<string>('corsOrigin');
  app.enableCors({
    origin: corsOrigin
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  // SIGINT/SIGTERM da OnModuleDestroy (bot polling stop) ishlashi uchun
  app.enableShutdownHooks();

  const port = config.getOrThrow<number>('port');
  const appUrl = config.getOrThrow<string>('appUrl');
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API running on ${appUrl}/${prefix}`);
}

void bootstrap();
