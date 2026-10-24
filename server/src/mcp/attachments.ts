// MCP: Attachments (#51).
import { z } from 'zod';
import * as attachments from '../records/attachments.js';
import { type McpContext } from './registrar.js';

export function registerAttachmentsTools({ user, tool }: McpContext) {
  tool('list_attachments', 'Attachments of a record (problem, incident, change, CI): screenshots, logs, configuration, PDFs. Text attachments flagged with credential/token/private_key may contain secrets.', { ref: z.string() }, true, async ({ ref }) =>
    (await attachments.listAttachments(user, ref)).map((a: any) => ({ id: a.id, filename: a.filename, kind: a.kind, size: a.size, flags: a.flags, created_at: a.created_at })),
  );
  tool(
    'read_attachment',
    'Read an attachment: text attachments as lines (from/limit; first_error_line points at the first ERROR/Exception), images as an image when the installation allows images for AI. Text flagged as possibly containing secrets is not returned. PDFs and other files are not readable here.',
    { id: z.number().int(), from: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(2000).optional() },
    true,
    async ({ id, from, limit }) => {
      // What may reach the AI provider is the installation's data policy (images and flagged text are off by default).
      const r: any = await attachments.attachmentForAgent(user, id, from ?? 0, limit ?? 500);
      if (r.image) return { mcpContent: [{ type: 'image', data: r.image, mimeType: r.mimeType }, { type: 'text', text: `${r.filename} (${r.width}×${r.height})` }] };
      return r;
    },
  );
  tool(
    'add_attachment',
    'Attach a text file (a log excerpt, an analysis, a configuration) to a record. Do not attach secrets or personal data.',
    { ref: z.string(), filename: z.string().max(150), text: z.string().max(2_000_000) },
    false,
    async ({ ref, filename, text }) => attachments.addAttachment(user, ref, filename, Buffer.from(text, 'utf8')),
  );
}
