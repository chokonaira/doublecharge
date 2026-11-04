# Review: PayCo webhook handler

**This PR is unsafe.** The handler has no idempotency, no atomicity and no ordering protection, so it breaks every rule. The simplest proof is a duplicate delivery, which PayCo's at-least-once guarantee explicitly allows.

## Findings

1. **Duplicate deliveries are not deduplicated (breaks rules 1 and 3).**
   - Nothing records that an event was processed.
   - A second `charge.succeeded` delivery sets the order to "paid" again and adds 1000 to the balance again.
   - `ship(orderId)` is called with no `idempotencyKey`, so the order ships a second time.

2. **The balance update is a lost-update race.**
   - The handler reads the balance with `get` and writes it back with `set`.
   - Two deliveries running at the same time, for example S and R, both read balance 0. The last write wins.
   - It should use `db.update` or a `transaction`.

3. **Refunds subtract the cumulative total.**
   - `amountRefunded` is the total refunded so far, not the amount of this refund.
   - Refunds of 300 then 1000 total would subtract 1300 from the balance instead of 1000.
   - The handler needs to track how much it has already booked per charge and subtract only the difference.

4. **Events arriving out of order corrupt state.**
   - If the refunded event lands before the succeeded event, the later succeeded event overwrites status "refunded" with "paid".
   - It then ships a fully refunded order, which breaks rule 2.
   - The handler also spreads a stale `order` snapshot into its writes, so it can clobber concurrent status changes.

5. **A crash mid-handler leaves partial state.**
   - Being killed between the two `set`s, or before `ship`, leaves the order and balance inconsistent.
   - PayCo's redelivery then double-applies whatever had already been written.

6. **A Shipping timeout causes a second shipment on retry.**
   - With no idempotency key, a `timeout_after` from Shipping means the shipment exists.
   - When PayCo redelivers the event, the retry ships again.

## Attack

The succeeded event is delivered twice, one delivery after the other. Each delivery ships the order, and the balance ends up at 2000.

```json
{
  "summary": "Duplicate delivery of charge.succeeded ships the order twice and credits the seller 2000 instead of 1000.",
  "steps": [
    [{ "id": "S1", "action": "deliver", "event": "charge.succeeded" }],
    [{ "id": "S2", "action": "deliver", "event": "charge.succeeded" }]
  ]
}
```

VERDICT: UNSAFE