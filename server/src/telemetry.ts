// OpenTelemetry traces and metrics over OTLP, e.g. to Elastic APM or an EDOT / OpenTelemetry collector.
// Load before the application: node --import ./dist/telemetry.js dist/index.js (the Docker image does this).
// It does nothing unless OTEL_EXPORTER_OTLP_ENDPOINT (or the traces/metrics specific variant) is set.
// Standard OTEL_* variables apply: OTEL_EXPORTER_OTLP_HEADERS, OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES, ...
import { register } from 'node:module';

const enabled = !!(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT);

if (enabled && process.env.OTEL_SDK_DISABLED !== 'true') {
  // Lets the instrumentations patch ES modules (pg, fastify) as they are imported.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
  const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-proto');
  const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
  const { HttpInstrumentation } = await import('@opentelemetry/instrumentation-http');
  const { FastifyInstrumentation } = await import('@opentelemetry/instrumentation-fastify');
  const { PgInstrumentation } = await import('@opentelemetry/instrumentation-pg');

  process.env.OTEL_SERVICE_NAME ??= 'kernel';
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 30_000 })],
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => req.url === '/healthz' }),
      new FastifyInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });
  sdk.start();
  const shutdown = () => sdk.shutdown().catch(() => {});
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
