# Review: wallet withdrawal PR

**Verdict: unsafe.** The PR has a lost-update race that creates money. It also mishandles bank rejections.

## Issue 1: Non-atomic read-modify-write of the wallet (critical)

The code reads `wallet:u1`, then calls PayCo, then blindly `set`s `balance - amount` from the stale read. Instances run concurrently, so two different withdrawals can both read 10000. Each pays out 3000, and each writes 7000.

The result is wallet 7000 plus 6000 paid out, which totals 13000. That breaks Rule 2.

The same flaw breaks the `"insufficient_funds"` check. Concurrent requests can each pass it and together overdraw the wallet. Other services write this key too, so their updates can also be overwritten.

## Issue 2: Rejected payouts are not handled

When the bank rejects the payout, `createPayout` throws `payout_rejected`, and the request fails instead of returning `"rejected"`.

Retries with the same `requestId` hit PayCo's idempotency record and get the same error again. The request therefore never answers with a valid result, which breaks Rule 3.

## Issue 3: Timeouts propagate as errors

A `timeout` from PayCo also surfaces as a thrown error. Retrying is safe here thanks to idempotency, so this is less severe. However, the code relies entirely on the caller to retry.

## Suggested design

1. **Reserve funds first.** Debit the wallet atomically in a `db.transaction`, keyed by `requestId`, and only if the balance is sufficient. Record a withdrawal record such as `withdrawal:<requestId>` with a status of `reserved`, in the same transaction.
2. **Call `createPayout`.** Use `idempotencyKey = requestId`. Retry on `timeout`.
3. **On `payout_rejected`, refund.** Refund the wallet atomically, mark the record `rejected`, and return `"rejected"`.
4. **On success, mark the record `paid_out`.** A retry that finds an existing record resumes from that record's state instead of debiting again.

## Attack

Request A pauses right after reading the balance. Meanwhile, request B, with a different requestId, runs to completion. A then resumes using its stale balance.

```json
{
  "summary": "Two concurrent withdrawals both read balance 10000, both pay out 3000, and both write 7000, so 3000 is created out of thin air.",
  "steps": [
    [
      {
        "id": "A",
        "action": "withdraw",
        "requestId": "r1",
        "amount": 3000,
        "pause": {
          "when": "after",
          "call": "db.get",
          "occurrence": 1,
          "meanwhile": [
            [ { "id": "B", "action": "withdraw", "requestId": "r2", "amount": 3000 } ]
          ]
        }
      }
    ]
  ]
}
```

VERDICT: UNSAFE