export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn` over `items` with at most `concurrency` in flight; preserves order of results. */
export async function pMap<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>, concurrency = 8): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const nowS = () => Date.now() / 1000;
