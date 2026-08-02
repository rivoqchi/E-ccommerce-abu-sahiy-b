import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export enum PaymentWebhookEvent {
  Succeeded = 'payment.succeeded',
  Failed = 'payment.failed',
  Refunded = 'payment.refunded',
}

export class PaymentWebhookDto {
  @IsEnum(PaymentWebhookEvent)
  event!: PaymentWebhookEvent;

  @IsString()
  @MinLength(1)
  orderId!: string;

  @IsString()
  @MinLength(1)
  providerRef!: string;

  @IsOptional()
  @IsString()
  provider?: string;
}
