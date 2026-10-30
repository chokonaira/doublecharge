/** Yields to the event loop, so concurrent requests interleave the way they would against a real network. */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Values cross the "network" by copy, so mutating a returned object never writes through. */
export const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
