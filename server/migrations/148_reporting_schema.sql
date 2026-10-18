-- A read-only reporting schema for BI tools (Power BI, Grafana), #150. The kernel_reporting role (db.ts, only when
-- KERNEL_REPORTING_DB_PASSWORD is set) reads these views and nothing in public.
--
-- No free text and no personal data: refs, codes, priorities, timestamps, SLA results, categories, teams, services
-- and CIs. A test compares every column against an allowlist, so a new column is a decision.
--
-- Restricted records (ADR 0002) are left out by the views themselves. The views run with their owner's rights, and
-- the owner is often a superuser who bypasses row-level security; kernel.viewer cannot help either, since whoever
-- connects can set it. So each view filters "NOT restricted" explicitly, and is a security_barrier so that no
-- function in a reader's query sees a row before that filter has removed it. Links to a restricted record (an
-- incident's problem, a change's problem) show no ref. Team-scoped practices are not applied: the role reports on
-- the whole operation.
CREATE SCHEMA IF NOT EXISTS reporting;
COMMENT ON SCHEMA reporting IS 'Read-only views for BI tools: no free text, no personal data, no restricted records (#150).';

CREATE VIEW reporting.incidents WITH (security_barrier) AS
SELECT i.ref,
       i.status,
       i.priority,
       i.impact,
       i.urgency,
       i.category_id,
       c.name AS category,
       i.team_id,
       t.name AS team,
       i.source,
       i.is_major,
       i.resolution_code,
       i.classification,
       i.reopen_count,
       p.ref AS problem_ref,
       pi.ref AS parent_ref,
       s.name AS sla,
       i.created_at,
       i.responded_at,
       i.resolved_at,
       i.closed_at,
       i.major_declared_at,
       i.response_due_at,
       i.response_breached_at,
       i.resolution_due_at,
       i.resolution_breached_at,
       -- Met: done by the target and never breached; NULL without a target or while still running and not breached.
       CASE WHEN i.response_due_at IS NULL THEN NULL
            WHEN i.response_breached_at IS NOT NULL THEN false
            WHEN i.responded_at IS NULL THEN NULL
            ELSE i.responded_at <= i.response_due_at END AS response_sla_met,
       CASE WHEN i.resolution_due_at IS NULL THEN NULL
            WHEN i.resolution_breached_at IS NOT NULL THEN false
            WHEN i.resolved_at IS NULL THEN NULL
            ELSE i.resolved_at <= i.resolution_due_at END AS resolution_sla_met,
       i.sla_paused_minutes,
       (extract(epoch FROM i.responded_at - i.created_at) / 60)::int AS minutes_to_respond,
       (extract(epoch FROM i.resolved_at - i.created_at) / 60)::int AS minutes_to_resolve
FROM incidents i
LEFT JOIN categories c ON c.id = i.category_id
LEFT JOIN teams t ON t.id = i.team_id
LEFT JOIN slas s ON s.id = i.sla_id
LEFT JOIN problems p ON p.id = i.problem_id AND NOT p.restricted
LEFT JOIN incidents pi ON pi.id = i.parent_id AND NOT pi.restricted
WHERE NOT i.restricted;

CREATE VIEW reporting.problems WITH (security_barrier) AS
SELECT p.ref,
       p.status,
       p.priority,
       p.impact,
       p.urgency,
       p.category_id,
       c.name AS category,
       p.team_id,
       t.name AS team,
       p.detection,
       p.is_major,
       p.closure_code,
       p.classification,
       p.workaround <> '' AS has_workaround,
       p.workaround_effectiveness,
       p.ec_risk_level,
       p.created_at,
       p.known_error_at,
       p.resolved_at,
       p.closed_at,
       (extract(epoch FROM p.resolved_at - p.created_at) / 60)::int AS minutes_to_resolve
FROM problems p
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN teams t ON t.id = p.team_id
WHERE NOT p.restricted;

CREATE VIEW reporting.changes WITH (security_barrier) AS
SELECT ch.ref,
       ch.change_type,
       ch.status,
       ch.risk,
       ch.outcome,
       ch.source,
       ch.team_id,
       t.name AS team,
       ch.classification,
       p.ref AS problem_ref,
       ch.planned_start,
       ch.planned_end,
       ch.actual_start,
       ch.actual_end,
       ch.created_at,
       ch.closed_at,
       (extract(epoch FROM ch.actual_end - ch.actual_start) / 60)::int AS minutes_to_implement
FROM changes ch
LEFT JOIN teams t ON t.id = ch.team_id
LEFT JOIN problems p ON p.id = ch.problem_id AND NOT p.restricted
WHERE NOT ch.restricted;

-- SLA warnings and breaches as they fired, one row each.
CREATE VIEW reporting.sla_events WITH (security_barrier) AS
SELECT i.ref AS incident_ref, e.target, e.kind, e.fired_at
FROM sla_events e
JOIN incidents i ON i.id = e.incident_id
WHERE NOT i.restricted;

-- Services and CIs (services are CIs of class 'service'). No owners, contacts, descriptions or attributes.
CREATE VIEW reporting.cis WITH (security_barrier) AS
SELECT ci.ref,
       ci.class,
       ci.name,
       ci.ci_type,
       ci.status,
       ci.environment,
       ci.criticality,
       ci.in_catalogue,
       s.name AS sla,
       s.availability_target,
       ci.created_at,
       ci.missing_since
FROM configuration_items ci
LEFT JOIN slas s ON s.id = ci.sla_id;

-- How CIs relate, e.g. a server member_of a service, so a report can roll records up to the service.
CREATE VIEW reporting.ci_relationships WITH (security_barrier) AS
SELECT f.ref AS from_ref, r.type, t.ref AS to_ref
FROM ci_relationships r
JOIN configuration_items f ON f.id = r.from_ci
JOIN configuration_items t ON t.id = r.to_ci;

-- Which CIs and services each incident, problem and change touched.
CREATE VIEW reporting.record_cis WITH (security_barrier) AS
SELECT 'incident' AS record_type, i.ref AS record_ref, ci.ref AS ci_ref
FROM incident_cis x JOIN incidents i ON i.id = x.incident_id JOIN configuration_items ci ON ci.id = x.ci_id
WHERE NOT i.restricted
UNION ALL
SELECT 'problem', p.ref, ci.ref
FROM problem_cis x JOIN problems p ON p.id = x.problem_id JOIN configuration_items ci ON ci.id = x.ci_id
WHERE NOT p.restricted
UNION ALL
SELECT 'change', ch.ref, ci.ref
FROM change_cis x JOIN changes ch ON ch.id = x.change_id JOIN configuration_items ci ON ci.id = x.ci_id
WHERE NOT ch.restricted;
