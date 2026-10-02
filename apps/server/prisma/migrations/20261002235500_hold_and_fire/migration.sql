-- Hold and fire (P6-05b, ORD-016): items a waiter keeps from the kitchen until fired.
ALTER TYPE "OrderItemState" ADD VALUE 'HELD' BEFORE 'SENT';
