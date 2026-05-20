import Decimal from 'decimal.js';

export type Side = 'buy' | 'sell';
export type OrderStatus = 'open' | 'cancelled' | 'filled' | 'partially_filled' | 'rejected';

export interface Order {
  clOrdId: string;
  venueOrderId: string;
  side: Side;
  price: Decimal;
  volume: Decimal;
  status: OrderStatus;
  placedAt: Date;
}

export interface Fill {
  fillId: string;
  orderClOrdId: string;
  side: Side;
  price: Decimal;
  volume: Decimal;
  fee: Decimal;
  t: Date;
}

export interface OrderUpdate {
  venueOrderId: string;
  clOrdId?: string;
  status: OrderStatus;
  filledVolume: Decimal;
  t: Date;
}

export interface BookLevel { price: Decimal; volume: Decimal }
export interface BookSnapshot { pair: string; bids: BookLevel[]; asks: BookLevel[]; t: Date }

export interface FeeTier { makerBps: number; takerBps: number }

let _clOrdSeq = 0;
export function newClOrdId(prefix = 'bx'): string {
  _clOrdSeq = (_clOrdSeq + 1) & 0xffff;
  return `${prefix}-${Date.now().toString(36)}-${_clOrdSeq.toString(36)}`;
}
