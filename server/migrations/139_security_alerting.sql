-- Security alerting (#64, part 2): detection rules over security_events report to event management under the
-- reserved source "Kernel security". This rule turns the minor and worse ones into a security incident (Security
-- category, restricted); warnings stay alerts and notify administrators. Admins can give it a team, or turn it off.
INSERT INTO event_rules (name, position, conditions, impact, urgency, group_by, group_window_minutes, max_incidents_per_hour)
VALUES ('Security alerts', 0, '{"sources": ["Kernel security"], "min_severity": "minor"}', 2, 2, 'rule', 240, 3)
ON CONFLICT (name) DO NOTHING;

-- Start after the events already recorded: history is not news.
INSERT INTO settings (key, value) SELECT 'security_alert_cursor', jsonb_build_object('last_id', coalesce(max(id), 0)) FROM security_events
ON CONFLICT (key) DO NOTHING;
