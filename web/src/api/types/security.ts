/** /api/security-events, /api/admin/privacy and /api/audit: security events, alerting settings and the audit trail. */
export interface SecurityEvent {
  id: number;
  at: string;
  action: string;
  category: string;
  outcome: 'success' | 'failure' | 'denied' | 'blocked' | 'info';
  severity: string;
  user_id: number | null;
  user_name: string | null;
  username: string | null;
  account: string;
  actor_type: string;
  channel: string;
  token_prefix: string;
  ip: string | null;
  country: string;
  user_agent: string;
  request_id: string;
  target: string;
  detail: Record<string, unknown>;
  message: string;
}
export interface SecuritySummary {
  outcomes: Record<string, number>;
  top: { action: string; outcome: string; n: number }[];
}
export interface AlertCounting { enabled: boolean; threshold: number; window_minutes: number; rows?: number }
export interface AlertingSettings {
  enabled: boolean;
  failed_sign_ins: AlertCounting;
  denials: AlertCounting;
  bulk_export: AlertCounting & { rows: number };
  new_country: { enabled: boolean };
  new_admin: { enabled: boolean };
  credential_change: { enabled: boolean };
}
export interface AlertingStatus {
  settings: AlertingSettings;
  source: string;
  rules: { id: number; name: string; enabled: boolean; min_severity: string | null; team_id: number | null; team_name: string | null }[];
  open_alerts: { id: number; check_key: string; severity: string; message: string; count: number; last_seen: string; incident_ref: string | null }[];
}
export interface PrivacySettings { audit_context_days: number; security_event_days: number }
/** One entry of the audit trail, as /api/audit and /api/records/:ref/history return it. */
export interface AuditEntry {
  id: number;
  at: string;
  actor_user_id: number | null;
  actor_name: string;
  actor_type: string;
  channel: string;
  token_prefix: string;
  ip?: string;
  user_agent?: string;
  request_id: string;
  entity_type: string;
  entity_ref: string;
  action: string;
  changes: Record<string, unknown>;
  reason: string;
}
