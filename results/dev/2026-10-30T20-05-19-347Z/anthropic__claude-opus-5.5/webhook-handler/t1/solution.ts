// PayCo webhook handler.
//
// Design:
//  * Every event, of either type, is treated as "reconcile this charge".
//    We fetch the current charge from PayCo and bring our state in line with it.
//    A charge only exists at PayCo if it succeeded, so any event about a charge
//    means its amount must be credited once. `amountRefunded` only ever grows,
//    so we subtract just the part we have not applied yet. Because of this,
//    duplicate, concurrent and out-of-order events are all harmless.
//  * Per-charge progress lives in `charge:<id>`. It is updated in the same Db
//    transaction as the order and the balance, so a crash can never leave a
//    half-applied change.
//  * Shipping happens after that transaction has committed. It uses a stable
//    idempotency key per order, and a `shipped:<orderId>` marker is written only
//    after `ship` succeeds. If we crash or time out in between, PayCo retries
//    the event (we throw), the transaction is a no-op, and we call `ship` again
//    with the same key. That cannot create a second shipment.

interface ChargeRecord {
  orderId: string;
  amount: number;
  credited: boolean; // charge amount has been added to the seller's balance
  refunded: number; // refunded amount already subtracted from the balance
}

interface Order {
  id: string;
  sellerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "refunded";
}

function codedError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

export async function handleWebhook(event: PayCoEvent, ctx: Ctx): Promise<void> {
  if (event.type !== "charge.succeeded" && event.type !== "charge.refunded") return;
  const snapshot = event.data?.charge;
  if (!snapshot?.id) return;

  // Use PayCo's current view of the charge. This also guards against forged
  // events. Errors (e.g. timeout) propagate, so PayCo retries the event.
  const charge = await ctx.payco.getCharge(snapshot.id);
  const orderId = charge.metadata?.orderId ?? snapshot.metadata?.orderId;
  if (!orderId) return; // not a marketplace order charge; nothing to do

  const orderKey = `order:${orderId}`;
  const chargeKey = `charge:${charge.id}`;
  const chargesKey = `ordercharges:${orderId}`;
  const shippedKey = `shipped:${orderId}`;

  // amountRefunded is monotonic: take the larger of the two views.
  const totalRefunded = Math.min(
    charge.amount,
    Math.max(charge.amountRefunded ?? 0, snapshot.amountRefunded ?? 0),
  );

  const result = await ctx.db.transaction((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) return { missing: true as const };

    const rec: ChargeRecord = tx.get<ChargeRecord>(chargeKey) ?? {
      orderId,
      amount: charge.amount,
      credited: false,
      refunded: 0,
    };

    let delta = 0;
    if (!rec.credited) {
      delta += charge.amount;
      rec.credited = true;
    }
    if (totalRefunded > rec.refunded) {
      delta -= totalRefunded - rec.refunded;
      rec.refunded = totalRefunded;
    }
    tx.set(chargeKey, rec);

    const chargeIds = tx.get<string[]>(chargesKey) ?? [];
    if (!chargeIds.includes(charge.id)) {
      chargeIds.push(charge.id);
      tx.set(chargesKey, chargeIds);
    }

    if (delta !== 0) {
      const balKey = `balance:${order.sellerId}`;
      const bal = tx.get<number>(balKey) ?? 0;
      tx.set(balKey, bal + delta);
    }

    // Derive the order status from all charges seen for this order:
    //  - "paid" if any charge still has money that has not been refunded;
    //  - "refunded" if every credited charge is fully refunded;
    //  - otherwise unchanged.
    let anyLive = false;
    let anyCredited = false;
    for (const id of chargeIds) {
      const r = id === charge.id ? rec : tx.get<ChargeRecord>(`charge:${id}`);
      if (!r || !r.credited) continue;
      anyCredited = true;
      if (r.refunded < r.amount) anyLive = true;
    }
    const status: Order["status"] = anyLive ? "paid" : anyCredited ? "refunded" : order.status;
    if (status !== order.status) tx.set<Order>(orderKey, { ...order, status });

    const shipped = tx.get<boolean>(shippedKey) === true;
    return { missing: false as const, shouldShip: status === "paid" && !shipped };
  });

  if (result.missing) {
    // The order may not be visible yet. Throw so PayCo retries later.
    throw codedError("order_not_found", `order ${orderId} not found`);
  }
  if (!result.shouldShip) return;

  // Re-check right before shipping to narrow the window in which a full refund
  // lands between our transaction and the ship call.
  // Limitation: Shipping cannot take part in a Db transaction, so a refund that
  // commits in the instant between this read and `ship` can still be shipped.
  // This window cannot be closed fully with the APIs we have.
  const fresh = await ctx.db.get<Order>(orderKey);
  if (!fresh || fresh.status !== "paid") return;
  if ((await ctx.db.get<boolean>(shippedKey)) === true) return;

  // Stable key: retries and concurrent deliveries create at most one shipment.
  // A timeout propagates, so PayCo retries and we call again with the same key.
  await ctx.shipping.ship(orderId, { idempotencyKey: `ship:${orderId}` });
  await ctx.db.set(shippedKey, true);
}
