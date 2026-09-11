/**
 * Runs `work` over `items`, at most `limit` at a time.
 *
 * Workers pulling from a shared cursor rather than fixed slices, so one slow item delays the next
 * one and not a whole quarter of the list. Never rejects: callers handle their own failures, and
 * a pool that threw would take its caller down with it.
 */
export async function pool<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      await work(items[index]);
    }
  });

  await Promise.all(workers);
}
