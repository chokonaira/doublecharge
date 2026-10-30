// A buggy retry loop that never yields to the event loop (pure microtasks): the 5s scenario timer can never fire.
export async function splitOrder(order: any): Promise<any> {
  for (;;) { try { await Promise.reject(new Error("retry")); } catch { /* retry */ } }
}
