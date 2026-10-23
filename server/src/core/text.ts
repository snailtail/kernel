// Small text helpers shared by mail, notices and server-rendered pages.

/** "1 problem", "3 problems"; pass `many` for irregular plurals. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Cut to at most n characters, ending with an ellipsis when cut. */
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Upper-case the first letter. */
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Escape for HTML text and quoted attributes. */
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** One CSV cell: quoted when needed, and spreadsheet formulas neutralised. */
export const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formulas (CSV injection): text starting with = + - @ tab or CR is prefixed with '.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
