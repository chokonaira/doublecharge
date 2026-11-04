interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface Charge {
  id: string;
  status: "succeeded";
}

interface ChargeParams {
  amount: number;
  currency: string;
  customerId: string;
}

interface PayCo {
  createCharge(
    params: ChargeParams & { idempotencyKey: string }
  ): Promise<Charge>;
}

// Only the runtime APIs used by checkout are described here.
interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

interface Order extends ChargeParams {
  id: string;
  status: "pending" | "paid" | "declined";
}

interface Attempt {
  number: number;
  params: ChargeParams;
  idempotencyKey: string;
  status: "charging" | "declined" | "paid";
  chargeId?: string;
}

type Selection = { paid: true } | { paid: false; attempt: Attempt };

function isCardDeclined(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "card_declined"
  );
}

function assertSamePayment(order: Order, attempt: Attempt): void {
  if (
    order.amount !== attempt.params.amount ||
    order.currency !== attempt.params.currency ||
    order.customerId !== attempt.params.customerId
  ) {
    // An unresolved payment cannot safely be replaced with different parameters.
    throw new Error("Order payment details changed during checkout");
  }
}

export async function checkout(
  orderId: string,
  ctx: Ctx
): Promise<"paid" | "declined"> {
  const orderKey = `order:${orderId}`;
  const attemptKey = `checkout:attempt:${orderId}`;

  /*
   * Keep this record durably, including after a decline. Never recycle order IDs
   * or attempt numbers: they determine PayCo's idempotency keys.
   *
   * An unresolved attempt has no lease or expiration. Any instance may finish
   * it, always using its original key and parameters.
   */
  const selection = await ctx.db.transaction<Selection>((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error("Order not found");

    // A paid order is terminal and is written only after confirmed payment.
    if (order.status === "paid") return { paid: true };

    const previous = tx.get<Attempt>(attemptKey);

    if (previous?.status === "paid") {
      throw new Error("Inconsistent paid order state");
    }

    if (previous?.status === "charging") {
      assertSamePayment(order, previous);
      return { paid: false, attempt: previous };
    }

    /*
     * Never select a previously recorded decline for a new request. We cannot
     * know whether an HTTP response actually reached the customer, so retire
     * the decline before returning it, even if that response might be lost.
     */
    const number = previous ? previous.number + 1 : 1;
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error("Payment attempt counter exhausted");
    }

    const attempt: Attempt = {
      number,
      params: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
      },
      idempotencyKey: JSON.stringify(["checkout-charge-v1", orderId, number]),
      status: "charging",
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { paid: false, attempt };
  });

  if (selection.paid) return "paid";

  const attempt = selection.attempt;
  let charge: Charge | undefined;

  // Catch only the charge call: database failures must never become declines.
  try {
    charge = await ctx.payco.createCharge({
      ...attempt.params,
      idempotencyKey: attempt.idempotencyKey,
    });
  } catch (error) {
    if (!isCardDeclined(error)) {
      // In particular, a timeout leaves the attempt unresolved. A later request
      // safely repeats the same key instead of potentially charging twice.
      throw error;
    }
  }

  return ctx.db.transaction<"paid" | "declined">((tx) => {
    const order = tx.get<Order>(orderKey);
    if (!order) throw new Error("Order disappeared during checkout");

    // This request must not return declined after observing a paid order.
    if (order.status === "paid") return "paid";

    const current = tx.get<Attempt>(attemptKey);
    if (!current || current.number < attempt.number) {
      throw new Error("Payment attempt state is missing or inconsistent");
    }

    if (charge !== undefined) {
      // Only a confirmed decline permits advancing to another attempt.
      if (
        current.number !== attempt.number ||
        current.status !== "charging"
      ) {
        throw new Error("Successful charge conflicts with payment state");
      }

      assertSamePayment(order, attempt);
      tx.set<Attempt>(attemptKey, {
        ...current,
        status: "paid",
        chargeId: charge.id,
      });
      tx.set<Order>(orderKey, { ...order, status: "paid" });
      return "paid";
    }

    if (current.status === "paid") {
      throw new Error("Inconsistent paid order state");
    }

    if (current.number === attempt.number) {
      tx.set<Attempt>(attemptKey, { ...current, status: "declined" });
      tx.set<Order>(orderKey, { ...order, status: "declined" });
    }
    // Otherwise, another request already recorded this decline and began a
    // newer attempt. Do not overwrite that newer attempt or its order status.

    /*
     * Our own charge call definitively declined. At selection, this attempt
     * was either new or unresolved; nobody could already have returned its
     * decline, because recording the decline must precede returning it.
     *
     * Any newer attempt necessarily began after our selection, so any charge
     * from it occurred after this request started. A concurrent payment after
     * this transaction's final observation is the unavoidable allowed race.
     */
    return "declined";
  });
}
