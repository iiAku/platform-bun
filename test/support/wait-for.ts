/**
 * Retries `assertion` until it stops throwing, every `interval` ms, and fails
 * with its last error once `timeout` ms have passed.
 */
export async function waitFor<T>(
  assertion: () => T | Promise<T>,
  {
    timeout = 1000,
    interval = 50,
  }: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    try {
      return await assertion();
    } catch (error) {
      if (performance.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}
