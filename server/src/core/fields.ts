// Field rules shared by the record schemas (#241), so a limit is changed in one place.
import { z } from 'zod';

/** Free text such as a description, a comment or a plan. */
export const longText = z.string().max(20000);

/** A record's title: trimmed and required. */
export const title = z.string().trim().min(1).max(300);

/** A point in time as ISO 8601 with an offset, e.g. 2026-11-07T09:00:00Z. */
export const instant = z.iso.datetime({ offset: true });
