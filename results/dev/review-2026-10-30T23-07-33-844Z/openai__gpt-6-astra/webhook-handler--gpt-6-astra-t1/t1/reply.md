No allowed sequence breaks the listed rules.

- **No duplicate shipments:** Every attempt uses the same order-scoped Shipping idempotency key. Concurrent calls, timeouts, and crashes after shipment creation cannot create a second shipment.
- **No prohibited shipment:** Before shipping, the handler reads the current charge from PayCo and reconciles it in another transaction. A full refund already present when the delivery started therefore prevents shipment. If that transaction reads an order marked `"refunded"`, the corresponding receipt also records the full refund, so reconciliation returns `false`. Refunds occurring after the last relevant check fall within the rule’s permitted race.
- **Correct final accounting:** Each transaction atomically updates the receipt, balance, and order status. The recorded refunded total only increases, and the balance adjustment is the difference between the previous and next net charge amounts. Duplicate or out-of-order events therefore cannot double-credit, double-debit, or reverse a full refund.
- **Recovery after interruption:** The handler records `shipped: true` only after Shipping returns successfully. If interrupted beforehand, a redelivery can retry with the same idempotency key. Once all events settle, the largest refund total is reflected in the balance and status, and a non-fully-refunded order has shipped.

VERDICT: SAFE