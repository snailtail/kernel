/** /api/tokens, /api/auth/*, /api/notifications and /api/setup: a person's own tokens, sessions, second factors, notifications and the setup state. */
export interface ApiToken {
  scopes?: string[];
  last_used_ip?: string;
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  token?: string;
}
export interface UserSession { id: string; created_at: string; last_seen_at: string; ip: string; user_agent: string; current: boolean }
interface ModuleInfo { key: string; label: string; description: string; enabled: boolean }
export interface SetupState { completed: boolean; has_real_data: boolean; demo_records: number; modules: ModuleInfo[] }
export interface Passkey { id: number; name: string; backed_up: boolean; created_at: string; last_used_at: string | null }
export interface TwoFactorStatus { enabled: boolean; enabled_at: string | null; recovery_codes_left: number; required: boolean }
interface NotificationItem { id: number; event: string; ref: string; title: string; summary: string; url: string; created_at: string; read_at: string | null }
export interface NotificationList { unread: number; notifications: NotificationItem[] }
export interface NotificationSettings {
  email: boolean; digest: boolean; has_chat: boolean; chat_format: string; address: string | null; email_configured: boolean;
  events: Record<string, { label: string; email: boolean; chat: boolean }>;
}
