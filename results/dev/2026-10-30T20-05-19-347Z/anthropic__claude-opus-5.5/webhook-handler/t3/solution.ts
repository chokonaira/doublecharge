// PayCo webhook handler.
//
// Design:
// - We don't dedupe by event id. Each charge has a state record in the Db at
//   `paycoCharge:<chargeId>`. It holds what we have already applied for that
//   charge: whether the credit was added and how much refund was subtracted.
//   Every event moves that state toward the charge's actual state at PayCo.
//   The effect is applied as the difference between the target and what was
//   already applied, so duplicates, concurrent deliveries, out-of-order events
//   and retries after a crash are all safe.
// - Order status, seller balance and charge state change in one Db transaction.
//   A crash leaves either all of it or none of it.
// - Any event for a charge proves the charge succeeded, since a refund implies
//   a prior success. So a refund event that arrives before `charge.succeeded`
//   still applies the credit first.
// - amountRefunded only ever grows. We take the max of the event payload, the
//   fresh charge from PayCo and what we already applied.
// - Shipping happens after the transaction. It uses a per-order idempotency key
//   and a `shipped:<orderId>` marker, so a crash between ship() and the marker
//   write just re-ships idempotently on the retried delivery. We skip shipping
//   when the charge is fully refunded.
//   Limitation: if a full refund happens at PayCo between our getCharge() and
//   ship(), the order can still ship. The Shipping API has no cancel, so we
//   cannot close that race.

interface ChargeState {
  credited: boolean; // charge amount added to the seller balance
  refundedApplied: number; // refund amount already subtracted from the balance
}

interface Order {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

function errWithCode(message: string, code: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

export async function handleWebhook(event: PayCoEvent, ctx: Ctx): Promise<void> {
  if (event.type !== "charge.succeeded" && event.type !== "charge.refunded") return;

  const evCharge = event.data.charge;
  const orderId = evCharge.metadata?.orderId;
  if (!orderId) return; // not a marketplace order charge; nothing to do

  // Fetch the current charge so we converge on the real PayCo state.
  // If this throws (e.g. timeout), let it propagate: PayCo will retry.
  const fresh = await ctx.payco.getCharge(evCharge.id);
  const chargeAmount = fresh.amount;
  const observedRefunded = Math.min(
    chargeAmount,
    Math.max(evCharge.amountRefunded ?? 0, fresh.amountRefunded ?? 0),
  );

  const orderKey = `order:${orderId}`;
  const stateKey = `paycoCharge:${evCharge.id}`;

  const result = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) {
      // Throwing writes nothing; PayCo retries later (order may not be visible yet).
      throw errWithCode(`order ${orderId} not found`, "order_not_found");
    }
    const balanceKey = `balance:${order.sellerId}`;
    const state: ChargeState = tx.get<ChargeState>(stateKey) ?? { credited: false, refundedApplied: 0 };
    let balance = tx.get<number>(balanceKey) ?? 0;

    const targetRefunded = Math.max(state.refundedApplied, observedRefunded);
    let changed = false;

    if (!state.credited) {
      balance += chargeAmount;
      state.credited = true;
      changed = true;
    }
    const refundDelta = targetRefunded - state.refundedApplied;
    if (refundDelta > 0) {
      balance -= refundDelta;
      state.refundedApplied = targetRefunded;
      changed = true;
    }

    const fullyRefunded = state.refundedApplied >= chargeAmount;
    const newStatus: Order["status"] = fullyRefunded ? "refunded" : "paid";
    // Never regress a refunded order back to paid.
    if (order.status !== newStatus && order.status !== "refunded") {
      tx.set<Order>(orderKey, { ...order, status: newStatus });
    } else if (fullyRefunded && order.status !== "refunded") {
      tx.set<Order>(orderKey, { ...order, status: "refunded" });
    }

    if (changed) {
      tx.set<number>(balanceKey, balance);
      tx.set<ChargeState>(stateKey, state);
    }
    return { fullyRefunded };
  });

  if (result.fullyRefunded) return; // do not ship fully refunded orders

  const shippedKey = `shipped:${orderId}`;
  if (await ctx.db.get<boolean>(shippedKey)) return;

  // Idempotent per order: concurrent or retried calls create at most one shipment.
  // A timeout propagates, so PayCo retries and we call again with the same key.
  await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });
  await ctx.db.set<boolean>(shippedKey, true);
}
