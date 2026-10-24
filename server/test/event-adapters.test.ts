import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adapt } from '../src/events/event-hooks.js';
import { redactUrl } from '../src/core/log.js';
import { ruleMatches } from '../src/events/events.js';
import { fixture } from './fixtures/events/load.js';

test('Alertmanager: one event per alert, labels mapped, resolved clears', () => {
  const firing = adapt('alertmanager', fixture('alertmanager-firing'));
  assert.equal(firing.length, 2);
  assert.deepEqual([firing[0].check, firing[0].host, firing[0].severity, firing[0].message], ['HighDiskUsage', 'web01.example.com', 'warning', 'Disk /var is 91% full']);
  assert.deepEqual([firing[1].host, firing[1].severity], ['10.0.9.77', 'critical']);
  assert.equal(adapt('alertmanager', fixture('alertmanager-resolved'))[0].severity, 'clear');
});

test('Uptime Kuma: down/up, test notifications ignored, stale heartbeats refused', () => {
  const down = adapt('uptime_kuma', fixture('uptime-kuma-down'));
  assert.deepEqual([down[0].check, down[0].host, down[0].severity, down[0].message], ['uptime #3', 'shop.example.com', 'critical', 'Webshop: Request failed with status code 503']);
  const tagged = fixture('uptime-kuma-down');
  tagged.monitor.tags = [{ name: 'ci', value: 'CI000012' }];
  assert.equal(adapt('uptime_kuma', tagged)[0].ci, 'CI000012');
  const maint = fixture('uptime-kuma-down');
  maint.heartbeat.status = 3;
  assert.equal(adapt('uptime_kuma', maint)[0].maintenance, true);
  assert.equal(adapt('uptime_kuma', fixture('uptime-kuma-up'))[0].severity, 'clear');
  assert.deepEqual(adapt('uptime_kuma', fixture('uptime-kuma-test')), []);
  assert.throws(() => adapt('uptime_kuma', fixture('uptime-kuma-down', -2 * 3600_000)), /replay window/);
});

test('Azure Monitor common alert schema: resource id, severity, resolved', () => {
  const fired = adapt('azure_monitor', fixture('azure-monitor-fired'));
  assert.equal(fired[0].ci_source_id, '/subscriptions/0000/resourceGroups/prod/providers/Microsoft.Sql/servers/sql-prod');
  assert.deepEqual([fired[0].check, fired[0].severity, fired[0].host], ['High CPU on sql-prod', 'major', 'sql-prod']);
  assert.equal(adapt('azure_monitor', fixture('azure-monitor-resolved'))[0].severity, 'clear');
  assert.throws(() => adapt('azure_monitor', { schemaId: 'other' }), /Not a valid azure_monitor payload/);
});

test('OP5: problem and recovery; acknowledgements ignored; strict types', () => {
  const p = adapt('op5', fixture('op5-problem'));
  assert.deepEqual([p[0].host, p[0].check, p[0].severity], ['mail01', 'SMTP queue', 'critical']);
  assert.equal(adapt('op5', fixture('op5-recovery'))[0].severity, 'clear');
  assert.deepEqual(adapt('op5', { ...fixture('op5-problem'), notification_type: 'ACKNOWLEDGEMENT' }), []);
  assert.throws(() => adapt('op5', { ...fixture('op5-problem'), state: 'ON FIRE' }), /Not a valid op5 payload/);
  assert.throws(() => adapt('op5', { ...fixture('op5-problem'), timestamp: 'yesterday' }), /Not a valid op5 payload/);
});

test('generic: single event or a batch, validated', () => {
  assert.equal(adapt('generic', { check: 'disk', severity: 'warning', host: 'h1' }).length, 1);
  assert.equal(adapt('generic', { events: [{ check: 'a', severity: 'info' }, { check: 'b', severity: 'clear' }] }).length, 2);
  assert.throws(() => adapt('generic', { check: 'disk', severity: 'apocalyptic' }), /Not a valid generic payload/);
});

test('rule conditions are evaluated from an allowlist', () => {
  const ci = { id: 1, ref: 'CI000001', name: 'db', ci_type: 'database', environment: 'prod', criticality: 1, status: 'active' };
  const alert = { severity: 'major', source: 'OP5', check_key: 'SMTP queue', count: 1, ci };
  assert.equal(ruleMatches({ min_severity: 'major', environments: ['prod'], max_ci_criticality: 2 }, alert), true);
  assert.equal(ruleMatches({ min_severity: 'critical' }, alert), false);
  assert.equal(ruleMatches({ min_count: 3 }, alert), false);
  assert.equal(ruleMatches({ ci_types: ['virtual_machine'] }, alert), false);
  assert.equal(ruleMatches({ check_contains: 'smtp' }, alert), true);
  assert.equal(ruleMatches({}, { ...alert, ci: null }), true);
  assert.equal(ruleMatches({ include_unmatched: false }, { ...alert, ci: null }), false);
});

test('tokens in query strings never reach the logs', () => {
  assert.equal(redactUrl('/api/event-hooks/3?token=kernel_evt_secret&x=1'), '/api/event-hooks/3?token=[REDACTED]&x=1');
});
