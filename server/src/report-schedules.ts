// Scheduled service reports (#54). A service owner (or a manager) asks for a service's report, or an organisation's
// services, monthly or quarterly. Once a period has ended it is queued once (one delivery per schedule and period)
// and sent by email: a short summary and a link, with the Markdown report attached. The report is read as the
// recipient with restricted records always left out, since mail leaves Kernel's access control.
import { z } from 'zod';
import type { User } from './auth.js';
import { audit } from './audit.js';
import { contextStore, currentContext } from './context.js';
import { query } from './db.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { sendReportMail } from './notifications.js';
import { authorize, can } from './policy.js';
import { serviceReport, serviceReportMarkdown } from './service-report.js';
import { viewerFor } from './visibility.js';
import { absoluteUrl } from './core/url.js';
import { backoffMinutes, processOutbox, SkipDelivery } from './core/outbox.js';

export const FREQUENCIES = ['monthly', 'quarterly'] as const;
export const scheduleSchema = z
  .object({
    service: z.string().trim().max(30).optional(),
    organisation_id: z.number().int().optional(),
    frequency: z.enum(FREQUENCIES),
  })
  .refine((s) => !!s.service !== (s.organisation_id != null), 'Give a service or an organisation');

const isManager = (user: { role: string }) => ['admin', 'manager'].includes(user.role);

const SELECT = `SELECT s.id, s.frequency, s.created_at, s.user_id, u.display_name AS recipient,
    c.ref AS service_ref, c.name AS service_name, o.id AS organisation_id, o.name AS organisation_name,
    (SELECT max(d.period) FROM report_deliveries d WHERE d.schedule_id = s.id AND d.status = 'sent') AS last_sent
  FROM report_schedules s JOIN users u ON u.id = s.user_id
  LEFT JOIN configuration_items c ON c.id = s.service_id LEFT JOIN organisations o ON o.id = s.organisation_id`;

/** My schedules; managers see everyone's, optionally for one service. */
export async function listSchedules(user: User, service?: string) {
  authorize(user, 'report.read');
  const { rows } = await query(
    `${SELECT} WHERE ($1::boolean OR s.user_id = $2) AND ($3::text IS NULL OR c.ref = $3) ORDER BY coalesce(c.name, o.name), s.frequency`,
    [isManager(user), user.id, service?.toUpperCase() ?? null],
  );
  return { schedules: rows };
}

export async function createSchedule(user: User, input: z.infer<typeof scheduleSchema>) {
  authorize(user, 'report.read');
  if (!(await query('SELECT email FROM users WHERE id = $1', [user.id])).rows[0]?.email) throw badRequest('Add an email address to your account first');
  let serviceId: number | null = null;
  if (input.service) {
    const { rows } = await query("SELECT id, owner_id FROM configuration_items WHERE ref = $1 AND class = 'service'", [input.service.toUpperCase()]);
    if (!rows[0]) throw notFound(`Service ${input.service} not found`);
    if (rows[0].owner_id !== user.id && !isManager(user)) throw forbidden("Only the service's owner or a manager can schedule its report");
    serviceId = rows[0].id;
  } else {
    if (!isManager(user)) throw forbidden("Only a manager can schedule an organisation's report");
    if (!(await query('SELECT 1 FROM organisations WHERE id = $1', [input.organisation_id])).rows[0]) throw notFound('Organisation not found');
  }
  const { rows } = await query(
    `INSERT INTO report_schedules (user_id, service_id, organisation_id, frequency) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, service_id, organisation_id, frequency) DO UPDATE SET frequency = EXCLUDED.frequency RETURNING id`,
    [user.id, serviceId, input.organisation_id ?? null, input.frequency],
  );
  await audit(null, { entity_type: 'report_schedule', entity_ref: String(rows[0].id), action: 'create', changes: { service: input.service ?? null, organisation_id: input.organisation_id ?? null, frequency: input.frequency } });
  return (await query(`${SELECT} WHERE s.id = $1`, [rows[0].id])).rows[0];
}

/** Your own schedule, or anyone's for a manager. */
export async function deleteSchedule(user: User, id: number) {
  authorize(user, 'report.read');
  const { rows } = await query('DELETE FROM report_schedules WHERE id = $1 AND ($2::boolean OR user_id = $3) RETURNING id', [id, isManager(user), user.id]);
  if (!rows[0]) throw notFound();
  await audit(null, { entity_type: 'report_schedule', entity_ref: String(id), action: 'delete', changes: {} });
}

/** The last complete period before `now`: the previous month or quarter, as a key and dates (UTC). */
function lastPeriod(frequency: (typeof FREQUENCIES)[number], now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const months = frequency === 'monthly' ? 1 : 3;
  const startMonth = frequency === 'monthly' ? m - 1 : Math.floor(m / 3) * 3 - 3;
  const start = new Date(Date.UTC(y, startMonth, 1));
  const end = new Date(Date.UTC(y, startMonth + months, 1));
  const key = frequency === 'monthly' ? start.toISOString().slice(0, 7) : `${start.getUTCFullYear()}-Q${start.getUTCMonth() / 3 + 1}`;
  return { key, from: start.toISOString().slice(0, 10), to: new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10), end };
}

/** Queues each schedule's last complete period once; a period that ended before the schedule existed is skipped. */
export async function queueScheduledReports(now = new Date()) {
  let queued = 0;
  for (const frequency of FREQUENCIES) {
    const p = lastPeriod(frequency, now);
    const { rowCount } = await query(
      `INSERT INTO report_deliveries (schedule_id, period, period_from, period_to)
       SELECT id, $2, $3, $4 FROM report_schedules WHERE frequency = $1 AND created_at < $5
       ON CONFLICT (schedule_id, period) DO NOTHING`,
      [frequency, p.key, p.from, p.to, p.end],
    );
    queued += rowCount ?? 0;
  }
  return queued;
}

/** Sends due deliveries; claimed with a lease so replicas never send the same one twice. */
export async function processReportDeliveries(limit = 10) {
  const { sent } = await processOutbox({
    table: 'report_deliveries', leaseSeconds: 300, limit, retryIn: backoffMinutes(5, 30, 120), permanent: /not configured/,
    send: async (d: any) => {
      const { rows: s } = await query(
        `SELECT s.*, u.username, u.display_name, u.email, u.role, u.active, c.ref AS service_ref, c.owner_id, o.name AS organisation_name
         FROM report_schedules s JOIN users u ON u.id = s.user_id
         LEFT JOIN configuration_items c ON c.id = s.service_id LEFT JOIN organisations o ON o.id = s.organisation_id
         WHERE s.id = $1`,
        [d.schedule_id],
      );
      const sch = s[0];
      // Who may have it is checked again at sending: an owner who handed the service on no longer gets its report.
      const allowed = sch && sch.active && sch.email && can(sch.role, 'report.read') && (isManager(sch) || (sch.service_id && sch.owner_id === sch.user_id));
      if (!allowed) throw new SkipDelivery('The recipient may no longer receive this report');
      await sendScheduled(sch, d);
    },
  });
  return sent;
}

async function sendScheduled(sch: any, d: any) {
  const recipient = { id: sch.user_id, username: sch.username, display_name: sch.display_name, email: sch.email, role: sch.role, preferences: {}, must_change_password: false, mfa_enabled: true } as User;
  // Read as the recipient, restricted records always left out: this goes by email.
  const viewer = await viewerFor(recipient, 'report', { unrestrictedOnly: true });
  const ctx = { ...currentContext(), userId: recipient.id, userName: recipient.display_name, actorType: 'system' as const, channel: 'report', viewer };
  await contextStore.run(ctx, async () => {
    const refs: string[] = sch.service_ref
      ? [sch.service_ref]
      : (await query("SELECT c.ref FROM organisation_services x JOIN configuration_items c ON c.id = x.ci_id WHERE x.organisation_id = $1 AND c.class = 'service' ORDER BY c.name", [sch.organisation_id])).rows.map((r) => r.ref);
    if (!refs.length) throw new Error('The organisation uses no services');
    const period = { from: d.period_from, to: d.period_to };
    const reports = [];
    for (const ref of refs) reports.push(await serviceReport(recipient, ref, period, { exported: true }));
    const title = sch.service_ref ? reports[0].service.name : sch.organisation_name;
    const query_ = `from=${period.from}&to=${period.to}`;
    const lines = [
      `${sch.frequency === 'monthly' ? 'Monthly' : 'Quarterly'} service report, ${period.from} – ${period.to}.`,
      '',
      ...reports.flatMap((r) => [
        `${r.service.name} (${r.service.ref})`,
        `  Availability ${r.availability.percent ?? '–'} %${r.availability.target != null ? ` (target ${r.availability.target} %)` : ''} · ${r.incidents.total} incidents · resolved within SLA ${r.incidents.resolution_sla ? `${r.incidents.resolution_sla.percent} %` : '–'} · change success ${r.changes.success_rate ?? '–'}${r.changes.success_rate != null ? ' %' : ''} · ${r.problems.length} open problems`,
        `  ${absoluteUrl(`/services/${r.service.ref}/report?${query_}`)}`,
        '',
      ]),
      'The full report is attached as Markdown. Restricted records are never included in mail.',
    ];
    const markdown = reports.map((r) => serviceReportMarkdown({ ...r, restricted_records_left_out: false })).join('\n\n---\n\n');
    await sendReportMail(recipient.email, `Kernel: service report ${title}, ${d.period}`, lines, {
      filename: `service-report-${(sch.service_ref ?? sch.organisation_name).replace(/[^\w-]+/g, '-')}-${d.period}.md`,
      content: markdown,
    }, absoluteUrl(sch.service_ref ? `/services/${sch.service_ref}/report` : '/reports'));
  });
}
