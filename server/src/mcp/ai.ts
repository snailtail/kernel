// MCP: AI tasks (#68): Kernel's configured model, under the same data policy as the web UI.
import { z } from 'zod';
import * as aiTasks from '../reporting/ai.js';
import { type McpContext } from './registrar.js';

export function registerAiTools({ user, tool }: McpContext) {
  tool('summarize_record', "Ask Kernel's configured model for a summary of a record (state, timeline, next steps). Subject to the installation's AI data policy.", { ref: z.string() }, true, async ({ ref }) => {
    const r = await aiTasks.summarize(user, ref);
    return { label: 'AI suggestion: check before relying on it', model: r.model, untrusted_content: { summary: r.text } };
  });
  tool('analyze_log', "Ask Kernel's configured model to analyse a text attachment (errors, timeline, probable cause). Logs are pre-filtered and secrets redacted first.", { attachment_id: z.number().int() }, true, async ({ attachment_id }) => {
    const r = await aiTasks.analyzeLog(user, attachment_id);
    return { label: 'AI suggestion: check the quoted lines', model: r.model, lines_sent: r.lines_sent, lines_total: r.lines_total, untrusted_content: { analysis: r.text } };
  });
}
