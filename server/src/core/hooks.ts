// In-process hooks: a lower layer offers a point that a higher layer fills in when it loads, so the lower one never
// imports the higher one (no import cycles, no `await import`). Every module that fills one is loaded by app.ts
// through its routes, before the first request or background job runs.

/** Something happened: every listener runs, in the order they registered. */
export function event<A extends unknown[]>() {
  const listeners: ((...args: A) => unknown)[] = [];
  return {
    on: (fn: (...args: A) => unknown) => void listeners.push(fn),
    emit: async (...args: A) => {
      for (const fn of listeners) await fn(...args);
    },
  };
}

/** One function a higher layer provides; until it does, the fallback answers. */
export function provided<A extends unknown[], R>(fallback: (...args: A) => R | Promise<R>) {
  let impl = fallback;
  return {
    provide: (fn: (...args: A) => R | Promise<R>) => void (impl = fn),
    call: async (...args: A): Promise<R> => impl(...args),
  };
}
