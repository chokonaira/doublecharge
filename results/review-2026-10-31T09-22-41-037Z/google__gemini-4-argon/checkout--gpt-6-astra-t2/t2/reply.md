This implementation is safe:

1. **No double charges (Rule 1):** An attempt's `idempotencyKey` is persisted in `checkout:attempt:<orderId>` with `status: "pending"` inside a transaction before calling `payco.createCharge`. Concurrent or retried requests reuse the existing pending `idempotencyKey`. A new `idempotencyKey` is generated only after the previous attempt has transitioned to `"declined"`, which only happens when PayCo definitively returns `card_declined` for that key.
2. **Valid declines (Rule 2):** A request only returns `"declined"` when its own `createCharge` call fails with `card_declined`, and because the key was either newly created by that request or still `"pending"` when read in the initial transaction, the customer could not have been informed of that decline before the request started, nor could a prior charge have succeeded.
3. **Valid paid responses and eventual settlement (Rules 3 & 4):** The order is only marked `"paid"` after `createCharge` succeeds, and transient failures (`timeout` or crashes) leave the attempt in `"pending"` so retries safely converge using the same idempotency key.

VERDICT: SAFE