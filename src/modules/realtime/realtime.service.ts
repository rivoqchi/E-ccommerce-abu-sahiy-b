import { Injectable } from '@nestjs/common';
import { Namespace } from 'socket.io';

@Injectable()
export class RealtimeService {
  private server: Namespace | null = null;

  setServer(server: Namespace) {
    this.server = server;
  }

  emitOrderStatus(orderId: string, payload: unknown) {
    this.server?.to(`order:${orderId}`).emit('order.status', payload);
    this.server?.to('admin').emit('order.status', payload);
  }

  emitProductStock(productId: string, payload: unknown) {
    this.server?.to(`product:${productId}`).emit('product.stock', payload);
  }

  emitCartUpdated(roomKey: string, payload: unknown) {
    this.server?.to(`cart:${roomKey}`).emit('cart.updated', payload);
  }

  emitAdminAlert(payload: unknown) {
    this.server?.to('admin').emit('admin.alert', payload);
  }
}
