// Background jobs on an interval. index.ts holds the one list of them; the jobs themselves are safe with several
// replicas, this only keeps one replica from running the same job twice at once.
import { logger } from '../log.js';

/**
 * Runs fn every ms milliseconds without keeping the process alive. A run that outlasts the interval makes the
 * next tick wait, `when` switches the job off (a module that is off), and a failure is logged with the job's name.
 * Returns a function that starts a run now (a wake-up); one that comes during a run starts another right after it.
 */
export function every(ms: number, name: string, fn: () => Promise<unknown>, options: { when?: () => boolean; firstAfter?: number } = {}) {
  let busy = false;
  let again = false;
  const run = async (wake = false): Promise<void> => {
    if (options.when && !options.when()) return;
    if (busy) return void (again ||= wake);
    busy = true;
    try {
      await fn();
    } catch (err) {
      logger.warn(`${name} failed: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
    if (again) {
      again = false;
      return run();
    }
  };
  setInterval(() => run(), ms).unref();
  if (options.firstAfter !== undefined) setTimeout(() => run(), options.firstAfter).unref();
  return () => run(true);
}
