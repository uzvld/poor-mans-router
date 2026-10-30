// Guards for data read from outside the process (benchmark sources, the on-disk history). The router
// takes no dependencies, so there is no schema library: each adapter checks the fields it uses.
// This is the one canonical guard module of the benchmark layer.

/** A plain object whose fields are still `unknown`: the caller checks the ones it reads. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
