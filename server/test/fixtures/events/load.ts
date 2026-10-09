import { readFileSync } from 'node:fs';

/** Loads a fixture with fresh timestamps. */
export function fixture(name: string, offsetMs = 0) {
  const now = new Date(Date.now() + offsetMs);
  const earlier = new Date(now.getTime() - 10 * 60_000);
  return JSON.parse(
    readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8')
      .replaceAll('{{NOW}}', now.toISOString())
      .replaceAll('{{EARLIER}}', earlier.toISOString())
      .replaceAll('{{NOW_KUMA}}', now.toISOString().replace('T', ' ').replace('Z', ''))
      .replaceAll('{{NOW_UNIX}}', String(Math.floor(now.getTime() / 1000))),
  );
}

