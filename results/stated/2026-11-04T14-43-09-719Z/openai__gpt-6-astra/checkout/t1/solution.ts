interface Tx {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

interface Db {
  transaction<T>(fn: (tx: Tx) => T): Promise<T>;
}

interface Charge {
  id: string;
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  status: "succeeded";
  amountRefunded: number;
  created: number;
}

interface PayCo {
  createCharge(params: ChargeParams): Promise<Charge>;
}

interface Ctx {
  db: Db;
  payco: PayCo;
  shipping: unknown;
}

interface Order {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "declined";
}

interface ChargeParams {
  amount: number;
  currency: string;
  customerId: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

interface Attempt {
  sequence: string;
  phase: "pending" | "declined" | "paid";
  params: ChargeParams;
  chargeId?: string;
}

function readOrder(tx: Tx, key: string, orderId: string): Order {
  const order = tx.get<Order>(key);
  if (!order) throw new Error(`Order not found: ${orderId}`);
  if (order.id !== orderId) throw new Error("Order ID mismatch");
  return order;
}

function samePayment(order: Order, params: ChargeParams): boolean {
  return (
    order.customerId === params.customerId &&
    order.amount === params.amount &&
    order.currency === params.currency
  );
}

function isCardDecline(error: unknown): boolean {
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
  const attemptKey = `checkout:attempt:v1:${orderId}`;

  const selection = await ctx.db.transaction<
    { kind: "paid" } | { kind: "charge"; attempt: Attempt }
  >((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    if (order.status === "paid") return { kind: "paid" };

    const previous = tx.get<Attempt>(attemptKey);

    // An unresolved attempt must keep its original parameters and key,
    // even after a timeout, process death, or a retry on another instance.
    if (previous?.phase === "pending") {
      if (!samePayment(order, previous.params)) {
        throw new Error("Order payment details changed during checkout");
      }
      return { kind: "charge", attempt: previous };
    }

    if (previous?.phase === "paid") {
      throw new Error("Inconsistent paid checkout state");
    }

    if (
      !Number.isSafeInteger(order.amount) ||
      order.amount < 0 ||
      typeof order.customerId !== "string" ||
      order.customerId.length === 0 ||
      typeof order.currency !== "string" ||
      order.currency.length === 0
    ) {
      throw new Error("Invalid order payment details");
    }

    // Decimal strings avoid eventual numeric counter overflow.
    const sequence = previous
      ? (BigInt(previous.sequence) + BigInt(1)).toString()
      : "1";

    const attempt: Attempt = {
      sequence,
      phase: "pending",
      params: {
        amount: order.amount,
        currency: order.currency,
        customerId: order.customerId,
        metadata: { orderId, checkoutAttempt: sequence },
        // Reserve this namespace for this integration. JSON tuple encoding
        // prevents collisions between different order IDs and sequences.
        idempotencyKey: `checkout:charge:v1:${JSON.stringify([
          orderId,
          sequence,
        ])}`,
      },
    };

    tx.set(attemptKey, attempt);
    tx.set<Order>(orderKey, { ...order, status: "pending" });
    return { kind: "charge", attempt };
  });

  if (selection.kind === "paid") return "paid";

  const attempt = selection.attempt;
  let charge: Charge;

  try {
    charge = await ctx.payco.createCharge(attempt.params);
  } catch (error: unknown) {
    // A timeout is ambiguous. Leave the attempt pending and throw so that
    // the next request retries exactly the same PayCo operation.
    if (!isCardDecline(error)) throw error;

    return ctx.db.transaction<"paid" | "declined">((tx) => {
      const order = readOrder(tx, orderKey, orderId);
      if (order.status === "paid") return "paid";

      const current = tx.get<Attempt>(attemptKey);
      if (!current) throw new Error("Missing checkout attempt");

      if (current.sequence === attempt.sequence) {
        if (current.phase === "paid") {
          throw new Error("Inconsistent PayCo charge outcome");
        }

        /*
         * Commit the decline before exposing it to the caller. A subsequent
         * request can then use a fresh key and charge an updated saved card.
         *
         * Delivery of the response cannot be committed atomically with Db.
         * If this process dies after this commit, conservatively treat the
         * decline as potentially delivered: the next request makes a fresh
         * attempt instead of presenting a possibly already-seen decline.
         */
        tx.set<Attempt>(attemptKey, { ...current, phase: "declined" });
        tx.set<Order>(orderKey, { ...order, status: "declined" });
      }

      /*
       * If a newer attempt exists, do not overwrite it. This request selected
       * this attempt while it was pending, before its decline could have been
       * reported. Its own charge call declined, and this final read did not
       * observe payment. A newer charge after that read is unavoidable.
       */
      return "declined";
    });
  }

  // Keep database errors outside the PayCo error handler.
  return ctx.db.transaction<"paid">((tx) => {
    const order = readOrder(tx, orderKey, orderId);
    if (order.status === "paid") return "paid";

    const current = tx.get<Attempt>(attemptKey);
    if (
      !current ||
      current.sequence !== attempt.sequence ||
      current.phase === "declined"
    ) {
      throw new Error("Inconsistent successful checkout attempt");
    }

    // If another subsystem edits payment details during checkout, do not
    // claim that the changed order was paid. Reconciliation must resolve it.
    if (!samePayment(order, attempt.params)) {
      throw new Error("Order payment details changed during checkout");
    }

    tx.set<Attempt>(attemptKey, {
      ...current,
      phase: "paid",
      chargeId: charge.id,
    });
    tx.set<Order>(orderKey, { ...order, status: "paid" });
    return "paid";
  });
}
