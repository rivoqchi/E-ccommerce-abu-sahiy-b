import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PingController } from './ping.controller';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController, PingController],
})
export class HealthModule {}
