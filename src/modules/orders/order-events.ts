import { EventEmitter } from 'events';

export const ORDER_CREATED_EVENT = 'order.created';

type OrderCreatedListener = (orderId: string) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(20);

export function emitOrderCreated(orderId: string) {
  emitter.emit(ORDER_CREATED_EVENT, orderId);
}

export function onOrderCreated(listener: OrderCreatedListener) {
  emitter.on(ORDER_CREATED_EVENT, listener);
  return () => {
    emitter.off(ORDER_CREATED_EVENT, listener);
  };
}
