/** Split into fixed-size chunks. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface SettledResult<T> {
  ok: T[];
  failures: Array<{ index: number; error: Error }>;
}

/**
 * Map with bounded concurrency, collecting failures instead of throwing.
 *
 * A poll tick covers the whole fleet. One bad batch must not abort the other
 * forty — partial data plus a recorded error is far more useful than nothing,
 * and the next tick will retry anyway.
 *
 * Concurrency matters for a second reason: **no rate limit is documented
 * anywhere in the Videri API and no operation declares a 429.** We have no
 * published budget to work to, so we keep parallelism deliberately modest and
 * let the HTTP layer back off if the gateway pushes back.
 */
export async function mapSettled<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<SettledResult<R>> {
  const ok: R[] = [];
  const failures: Array<{ index: number; error: Error }> = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        ok.push(await fn(items[index]!, index));
      } catch (error) {
        failures.push({
          index,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  return { ok, failures };
}
