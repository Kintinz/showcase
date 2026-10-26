// Drain in-flight operations before rejecting, and never start more work after failure.
export async function mapLimit(items, limit, operation) {
  const results = new Array(items.length); let next = 0, failure;
  async function worker() {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await operation(items[index], index); }
      catch (error) { failure ||= error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
  return results;
}
