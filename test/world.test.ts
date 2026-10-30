import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asInvocation, callsSincePlan, errorCode, InstanceCrashed, MemoryDb, PayCo, planCrash, Shipping } from "../src/world/index.ts";

const charge = { amount: 500, currency: "EUR", customerId: "cus_1" };

describe("PayCo idempotency", () => {
  it("replays the original charge for a repeated key", async () => {
    const payco = new PayCo();
    const first = await payco.createCharge({ ...charge, idempotencyKey: "k" });
    const second = await payco.createCharge({ ...charge, idempotencyKey: "k" });
    assert.equal(second.id, first.id);
    assert.equal(payco.charges.length, 1);
  });

  it("rejects a key reused with different parameters", async () => {
    const payco = new PayCo();
    await payco.createCharge({ ...charge, idempotencyKey: "k" });
    await assert.rejects(payco.createCharge({ ...charge, amount: 501, idempotencyKey: "k" }), (e) => errorCode(e) === "idempotency_mismatch");
  });

  it("treats the same parameters in a different order, or with undefined fields, as the same request", async () => {
    const payco = new PayCo();
    await payco.createCharge({ amount: 500, currency: "EUR", customerId: "cus_1", metadata: { a: "1", b: "2" }, idempotencyKey: "k" });
    await payco.createCharge({ customerId: "cus_1", currency: "EUR", amount: 500, metadata: { b: "2", a: "1" }, idempotencyKey: "k" });
    await payco.createCharge({ customerId: "cus_1", currency: "EUR", amount: 500, metadata: { b: "2", a: "1" }, idempotencyKey: "k", ...{ extra: undefined } });
    assert.equal(payco.charges.length, 1);
  });

  it("replays a decline for the same key", async () => {
    const payco = new PayCo({ createCharge: ["decline"] });
    await assert.rejects(payco.createCharge({ ...charge, idempotencyKey: "k" }), (e) => errorCode(e) === "card_declined");
    await assert.rejects(payco.createCharge({ ...charge, idempotencyKey: "k" }), (e) => errorCode(e) === "card_declined");
    assert.equal(payco.charges.length, 0);
  });

  it("deduplicates concurrent requests with the same key", async () => {
    const payco = new PayCo();
    await Promise.all([payco.createCharge({ ...charge, idempotencyKey: "k" }), payco.createCharge({ ...charge, idempotencyKey: "k" })]);
    assert.equal(payco.charges.length, 1);
  });
});

describe("PayCo faults", () => {
  it("timeout_after processes the charge but throws", async () => {
    const payco = new PayCo({ createCharge: ["timeout_after"] });
    await assert.rejects(payco.createCharge(charge), (e) => errorCode(e) === "timeout");
    assert.equal(payco.charges.length, 1);
  });

  it("timeout_before throws without processing", async () => {
    const payco = new PayCo({ createCharge: ["timeout_before"] });
    await assert.rejects(payco.createCharge(charge), (e) => errorCode(e) === "timeout");
    assert.equal(payco.charges.length, 0);
  });

  it("charges twice without a key", async () => {
    const payco = new PayCo();
    await payco.createCharge(charge);
    await payco.createCharge(charge);
    assert.equal(payco.charges.length, 2);
  });
});

describe("MemoryDb", () => {
  it("interleaves read-then-write across concurrent callers", async () => {
    const db = new MemoryDb({ n: 0 });
    const increment = async () => db.set("n", ((await db.get<number>("n")) ?? 0) + 1);
    await Promise.all([increment(), increment()]);
    assert.equal(db.peek("n"), 1, "lost update is the point: get/set is not atomic");
  });

  it("update is atomic", async () => {
    const db = new MemoryDb({ n: 0 });
    await Promise.all([db.update<number>("n", (n = 0) => n + 1), db.update<number>("n", (n = 0) => n + 1)]);
    assert.equal(db.peek("n"), 2);
  });

  it("insertIfAbsent admits exactly one concurrent caller", async () => {
    const db = new MemoryDb();
    const results = await Promise.all([db.insertIfAbsent("k", 1), db.insertIfAbsent("k", 2)]);
    assert.deepEqual(results.sort(), [false, true]);
  });

  it("returns copies, so mutation does not write through", async () => {
    const db = new MemoryDb({ o: { status: "pending" } });
    const order = await db.get<{ status: string }>("o");
    if (order) order.status = "paid";
    assert.deepEqual(db.peek("o"), { status: "pending" });
  });

  it("does not write when update throws", async () => {
    const db = new MemoryDb({ n: 1 });
    await assert.rejects(db.update("n", () => {
      throw new Error("abort");
    }));
    assert.equal(db.peek("n"), 1);
  });
});

describe("Shipping", () => {
  it("deduplicates by idempotency key and records lost responses", async () => {
    const shipping = new Shipping(["timeout_after"]);
    await assert.rejects(shipping.ship("o1", { idempotencyKey: "s" }));
    await shipping.ship("o1", { idempotencyKey: "s" });
    assert.equal(shipping.count("o1"), 1);
  });
});

describe("PayCo scenario controls", () => {
  it("rejects payouts with payout_rejected and moves no money", async () => {
    const payco = new PayCo({ createPayout: ["decline"] });
    await assert.rejects(payco.createPayout({ amount: 100, currency: "EUR", destination: "u1" }), (e) => errorCode(e) === "payout_rejected");
    assert.equal(payco.payouts.length, 0);
  });

  it("clearFaults ends an outage", async () => {
    const payco = new PayCo({ createCharge: ["timeout_before", "timeout_before"] });
    await assert.rejects(payco.createCharge(charge));
    payco.clearFaults();
    await payco.createCharge(charge);
    assert.equal(payco.charges.length, 1);
  });

  it("setRefunded is visible through getCharge", async () => {
    const payco = new PayCo();
    const created = await payco.createCharge(charge);
    payco.setRefunded(created.id, 200);
    assert.equal((await payco.getCharge(created.id)).amountRefunded, 200);
  });
});

describe("MemoryDb transactions", () => {
  it("commits every write at once and returns the result", async () => {
    const db = new MemoryDb({ a: 1 });
    const result = await db.transaction((tx) => {
      tx.set("a", (tx.get<number>("a") ?? 0) + 1);
      tx.set("b", tx.get<number>("a"));
      tx.delete("missing");
      return "done";
    });
    assert.equal(result, "done");
    assert.deepEqual([db.peek("a"), db.peek("b")], [2, 2]);
  });

  it("writes nothing when the function throws", async () => {
    const db = new MemoryDb({ a: 1 });
    await assert.rejects(
      db.transaction((tx) => {
        tx.set("a", 2);
        tx.delete("a");
        throw new Error("abort");
      }),
    );
    assert.equal(db.peek("a"), 1);
  });

  it("serialises concurrent transactions", async () => {
    const db = new MemoryDb({ n: 0 });
    const bump = () => db.transaction((tx) => tx.set("n", (tx.get<number>("n") ?? 0) + 1));
    await Promise.all([bump(), bump(), bump()]);
    assert.equal(db.peek("n"), 3);
  });
});

describe("instance crashes", () => {
  it("before: the call never happens and the caller sees a dropped connection", async () => {
    const db = new MemoryDb();
    planCrash({ at: 2, mode: "before" });
    await assert.rejects(
      asInvocation(async () => {
        await db.set("first", 1);
        await db.set("second", 2);
      }),
      InstanceCrashed,
    );
    planCrash(undefined);
    assert.deepEqual([db.peek("first"), db.peek("second")], [1, undefined]);
  });

  it("after: the call happens, and a solution that swallows the crash still cannot act or answer", async () => {
    const db = new MemoryDb();
    planCrash({ at: 1, mode: "after" });
    await assert.rejects(
      asInvocation(async () => {
        try {
          await db.set("charged", true);
        } catch {
          await db.set("refunded", true).catch(() => {}); // a dead instance cannot do anything more
        }
        return "paid";
      }),
      InstanceCrashed,
    );
    planCrash(undefined);
    assert.deepEqual([db.peek("charged"), db.peek("refunded")], [true, undefined]);
  });

  it("only the instance that made the call dies, and calls outside the solution are not counted", async () => {
    const db = new MemoryDb();
    await db.set("setup", 1);
    planCrash({ at: 1, mode: "before" });
    const [a, b] = await Promise.allSettled([asInvocation(() => db.set("a", 1)), asInvocation(() => db.set("b", 1))]);
    planCrash(undefined);
    assert.equal(a.status, "rejected");
    assert.equal(b.status, "fulfilled");
    assert.equal(db.peek("b"), 1);
    assert.equal(callsSincePlan(), 0);
  });
});
