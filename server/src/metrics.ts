// Domain metrics and spans via the OpenTelemetry API; no-ops unless telemetry.ts started the SDK.
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';

const meter = metrics.getMeter('kernel');
const tracer = trace.getTracer('kernel');

const transitions = meter.createCounter('kernel.problem.transitions', { description: 'Problem status changes', unit: '{transition}' });
const created = meter.createCounter('kernel.problem.created', { description: 'Problems logged', unit: '{problem}' });
const toolCalls = meter.createCounter('kernel.mcp.tool_calls', { description: 'MCP tool calls', unit: '{call}' });

export function recordActivity(kind: string, data: any, attrs: { priority: number; detection?: string }) {
  if (kind === 'created') created.add(1, { 'problem.priority': attrs.priority, 'problem.detection': attrs.detection ?? 'unknown' });
  if (kind === 'status') transitions.add(1, { 'problem.from': data?.from, 'problem.to': data?.to, 'problem.priority': attrs.priority });
}

/** Runs an MCP tool inside a span and counts it. */
export async function traceTool<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`mcp.tool ${name}`, { attributes: { 'mcp.tool.name': name } }, async (span) => {
    try {
      const result = await fn();
      toolCalls.add(1, { 'mcp.tool.name': name, outcome: 'ok' });
      return result;
    } catch (err) {
      toolCalls.add(1, { 'mcp.tool.name': name, outcome: 'error' });
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
