## Review

I could not find any sequence the spec allows that breaks one of the rules. Here is why each rule holds.

**State is fetched fresh and refunds are applied by total, not by event.**
- The handler calls `getCharge` at the start of every delivery.
- It takes `totalRefunded` as the larger of PayCo's current total and the snapshot's total, capped at the charge amount.
- Inside a single `db.transaction` it does all of the following atomically:
  - credits the charge amount once, guarded by `rec.credited`;
  - subtracts only the growth of the refunded total since the last time it was booked (`totalRefunded - rec.refunded`);
  - recomputes the order status.
- Because of this, any mix of duplicate, concurrent, out-of-order or retried deliveries gives the same result. The balance is always 1000 minus the largest total observed. Each booking reflects PayCo's live total at the time, so the balance only moves toward the true value and never goes past it.

**Rule 1 (never shipped twice).**
- Every `ship` call uses the fixed key `ship:o1`, so Shipping creates at most one shipment.
- This holds even in the worst cases: concurrent deliveries that both see `shipped` as false, a crash between `ship` and `db.set(shippedKey)`, or a `ship` timeout.

**Rule 2 (no shipping when refunded).**
- If the charge was fully refunded before the delivery started, the `getCharge` at the start sees it. The transaction then sets the status to "refunded", so `shouldShip` is false and the delivery does not ship.
- Just before shipping, the handler re-reads the order and returns unless it is "paid". So the delivery's most recent read of the order can never show "refunded" when it ships.
- A refund booked after that last read is the race the rule explicitly excludes.

**Rule 3 (final state after settling).**
- **Balance:** settling redelivers every event that was not handled successfully, including the event for the final refund total. Every successful handling books PayCo's live total, so the balance ends at 1000 minus the final total.
- **Status:** it is "paid" when the charge is not fully refunded and "refunded" when it is.
- **Shipping when not fully refunded:** shipping errors (timeout, crash) make the handler throw or leave `shipped` unset. A later delivery then retries with the same key, which is safe. So an order that is not fully refunded ends up shipped.

**No in-process state.** Nothing is kept in memory between requests.

VERDICT: SAFE