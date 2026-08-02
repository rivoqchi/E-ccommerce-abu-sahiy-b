import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Namespace, Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { RealtimeService } from './realtime.service';

@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway implements OnGatewayInit {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Namespace;

  constructor(
    private readonly realtimeService: RealtimeService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  async afterInit(nsp: Namespace) {
    // Namespaced gateways receive a Namespace; emits must stay on that nsp.
    this.realtimeService.setServer(nsp);

    try {
      const redisUrl = this.configService.getOrThrow<string>('redisUrl');
      const pubClient = createClient({ url: redisUrl });
      const subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      // Adapter is set on the root Server, not the Namespace.
      const io: Server = nsp.server;
      io.adapter(createAdapter(pubClient, subClient));
      this.logger.log('Socket.io Redis adapter connected');
    } catch (err) {
      this.logger.warn(
        `Socket.io Redis adapter unavailable: ${(err as Error).message}`,
      );
    }
  }

  @SubscribeMessage('join')
  handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: { rooms?: string[]; token?: string },
  ) {
    const rooms = body?.rooms ?? [];

    if (body?.token) {
      try {
        const payload = this.jwtService.verify<{
          sub: string;
          role: string;
        }>(body.token, {
          secret: this.configService.getOrThrow<string>('jwt.secret'),
        });

        void client.join(`user:${payload.sub}`);
        void client.join(`cart:${payload.sub}`);
        if (payload.role === 'admin') {
          void client.join('admin');
        }
      } catch {
        this.logger.debug('Invalid socket auth token');
      }
    }

    for (const room of rooms) {
      if (
        room.startsWith('order:') ||
        room.startsWith('product:') ||
        room.startsWith('cart:')
      ) {
        void client.join(room);
      }
    }

    return { joined: true, rooms: [...client.rooms] };
  }
}
