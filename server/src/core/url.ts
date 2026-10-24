import { config } from './config.js';

/** An absolute link to a Kernel path, from KERNEL_PUBLIC_URL (relative when it is not set). */
export const absoluteUrl = (path: string) => `${(config.publicUrl ?? '').replace(/\/$/, '')}${path}`;
