/** /api/admin/*, /api/users, /api/systems, /api/webhooks, /api/templates, /api/connectors: administration, backups and integrations. */
import type { Role } from '../../api';

/** /api/admin/backups: whether backups run and the files kept per tier. */
export interface BackupStatus {
  configured: boolean;
  last_success?: string | null;
  last_failure?: string | null;
  healthy?: boolean;
  files?: { tier: string; name: string; size: number; created_at: string }[];
}

export interface AdminUser {
  mfa_enabled: boolean;
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: Role;
  active: boolean;
  ci_source_systems: string[];
  change_templates: number[];
  created_at: string;
}
export interface ExternalSystem { id: number; name: string; url_templates: Record<string, string>; active: boolean }
export interface Webhook { id: number; name: string; url: string; format: string; events: string[]; services: string[]; active: boolean; failed: number; last_delivered_at: string | null; secret_set_at: string; secret?: string }
export interface Delivery { id: number; event: string; status: string; attempts: number; response_status: number | null; last_error: string | null; created_at: string; summary: string | null; ref: string | null }
/** What a template prefills on a new record. */
export interface TemplateFields { title?: string; description?: string; impact?: number; urgency?: number; category_id?: number; assignment_group?: string }
export interface RecordTemplate { id: number; kind: 'incident' | 'problem'; name: string; fields: TemplateFields; active: boolean }
export interface ConnectorRun { id?: number; trigger?: string; status: string; counts: Record<string, any>; errors?: { source_id?: string; error: string }[]; message: string; started_at: string; finished_at: string | null }
export interface Connector {
  id: number; type: string; name: string; source_system: string; config: Record<string, any>; private_allow: string[]; schedule_minutes: number; retire_after_days: number;
  enabled: boolean; next_run_at: string; running_until: string | null; has_secret: boolean; last_run: ConnectorRun | null;
}
export interface SsoSettings { enabled: boolean; issuer: string; client_id: string; has_secret: boolean; scopes: string; groups_claim: string; role_map: { group: string; role: string }[]; team_map: { group: string; team_id: number }[]; default_role: string | null; local_login: 'all' | 'admins'; label: string; trust_idp_mfa: boolean; mfa_acr_values: string[]; trust_email_claim?: boolean; redirect_uri: string }
export interface AiResult { text: string; model: string; provider: string; lines_sent?: number; lines_total?: number }
interface AiProvider {
  id: number; name: string; kind: string; base_url: string; has_key: boolean; models: string[]; location: 'on_prem' | 'cloud'; data_classes: string[];
  private_allow: string[]; monthly_token_budget: number; enabled: boolean; calls: number; tokens_this_month: string;
}
export interface ConnectorList { types: Record<string, string>; connectors: Connector[] }
export interface AiProviderList { providers: AiProvider[]; routing: Record<string, { provider_id: number; model: string }>; tasks: Record<string, string> }
export interface WebhookList { webhooks: Webhook[]; events: string[]; formats: string[] }
