interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface ChargeParameters {
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

interface Ctx {
  db: {
    transaction<T>(fn: (tx: Tx) => T): Promise<T>;
  };
  payco: {
    createCharge(parameters: ChargeParameters): Promise<{
      id: string;
      status: "succeeded";
    }>;
  };
  shipping: unknown;
}

interface Attempt {
  generation: string;
  parameters: ChargeParameters;
  outcome: "unresolved" | "declined" | "paid";
  chargeId?: string;
}

function isCardDeclined(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "card_declined"
  );
}

export async function checkout(
  orderId: string,
  ctx: Ctx,
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:v1:${orderId}`;

  const selected = await ctx.db.transaction<
    { kind: "paid" } | { kind: "attempt"; attempt: Attempt }
  >((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error(`Order not found: ${orderId}`);

    if (order.status === "paid") return { kind: "paid" };

    const previous = tx.get<Attempt>(attemptKey);

    if (previous?.outcome === "paid") {
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return { kind: "paid" };
    }

    if (previous?.outcome === "unresolved") {
      // Never abandon an uncertain payment, even after a timeout or crash.
      // Every instance must retry its exact persisted parameters and key.
      return { kind: "attempt", attempt: previous };
    }

    // A recorded decline is treated as potentially already communicated.
    // A request starting now must try the saved card again, not replay it.
    const generation = previous
      ? (BigInt(previous.generation) + BigInt(1)).toString()
      : "1";

    const attempt: Attempt = {
      generation,
      outcome: "unresolved",
      parameters: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId },
        idempotencyKey: `checkout:v1:${JSON.stringify([orderId, generation])}`,
      },
    };

    // This namespace and its attempt records must be retained: deleting them
    // would allow reuse of a previously used idempotency key.
    tx.set<Attempt>(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });

    return { kind: "attempt", attempt };
  });

  if (selected.kind === "paid") return "paid";

  const attempt = selected.attempt;
  let result:
    | { kind: "paid"; chargeId: string }
    | { kind: "declined" };

  // Only classify errors from PayCo, not errors from subsequent DB writes.
  try {
    const charge = await ctx.payco.createCharge(attempt.parameters);
    result = { kind: "paid", chargeId: charge.id };
  } catch (error) {
    if (!isCardDeclined(error)) {
      // In particular, timeout does not resolve or rotate this attempt.
      throw error;
    }
    result = { kind: "declined" };
  }

  const outcome = result;

  return ctx.db.transaction<"paid" | "declined">((tx) => {
    const order = tx.get<Order>(orderKey);
    const current = tx.get<Attempt>(attemptKey);

    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (!current) throw new Error(`Checkout state missing: ${orderId}`);

    // Once this request observes "paid", it must not report a decline.
    if (order.status === "paid") return "paid";

    if (current.outcome === "paid") {
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return "paid";
    }

    if (outcome.kind === "paid") {
      // An attempt can advance only following a definitive decline, so an
      // idempotently successful attempt cannot legitimately be superseded.
      if (current.generation !== attempt.generation) {
        throw new Error(`Inconsistent checkout state: ${orderId}`);
      }

      tx.set<Attempt>(attemptKey, {
        ...current,
        outcome: "paid",
        chargeId: outcome.chargeId,
      });
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return "paid";
    }

    if (current.generation === attempt.generation) {
      /*
       * Commit the decline before returning it. DB commits and delivery to
       * the customer cannot be atomic. If delivery fails, the next request
       * conservatively makes a new attempt rather than repeating a decline
       * that the customer might already have seen.
       */
      tx.set<Attempt>(attemptKey, { ...current, outcome: "declined" });
      tx.set<Order>(orderKey, { ...order, status: "declined" });
    }

    /*
     * A superseded decline must not overwrite a newer attempt's state.
     * This request selected its attempt before its decline was recorded as
     * potentially communicated, and its own charge call definitively declined.
     * No later attempt could have charged before this request started:
     * advancement requires recording that selected attempt's decline first.
     */
    return "declined";
  });
}
