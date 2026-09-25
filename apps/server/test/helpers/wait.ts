/**
 * Polls `find` until it returns a value (not undefined or false) or the timeout passes. For
 * conditions reached asynchronously: events dispatched, sockets closed, retries done.
 */
export async function until<T>(
  find: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 5_000,
  what = 'a condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
