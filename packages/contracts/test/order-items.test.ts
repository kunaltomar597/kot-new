import { describe, expect, it } from 'vitest';
import {
  ModifyOrderItemRequest,
  OrderItemEndRequest,
  OrderItemStatusRequest,
} from '../src/index.js';

describe('[ORD-010] [ORD-011] [ORD-012] item changes', () => {
  it('knows the floor and kitchen steps only', () => {
    expect(OrderItemStatusRequest.safeParse({ event: 'SERVE' }).success).toBe(true);
    expect(OrderItemStatusRequest.safeParse({ event: 'VOID' }).success).toBe(false);
  });

  it('needs a reason to cancel or void, and some change to modify', () => {
    expect(OrderItemEndRequest.safeParse({ reason: 'Burnt' }).success).toBe(true);
    expect(OrderItemEndRequest.safeParse({ reason: '' }).success).toBe(false);
    expect(ModifyOrderItemRequest.safeParse({}).success).toBe(false);
    expect(ModifyOrderItemRequest.safeParse({ instructions: null }).success).toBe(true);
    expect(ModifyOrderItemRequest.safeParse({ quantity: 0 }).success).toBe(false);
  });
});
