/** /api/alerts, /api/event-rules, /api/event-sources, /api/maintenance-windows: monitoring events. */
export interface Alert {
  id: number; source: string; check_key: string; severity: string; status: 'open' | 'closed'; message: string; source_url: string;
  count: number; flap_count: number; flapping: boolean; first_seen: string; last_seen: string; cleared_at: string | null; suppressed: string;
  ci_hint: string; ci_ref: string | null; ci_name: string | null; incident_ref: string | null; incident_status: string | null;
  acknowledged_by: string | null; rule: string | null;
}
export interface EventRule {
  id: number; name: string; enabled: boolean; position: number; impact: number; urgency: number; assignment_group: string;
  group_by: 'service' | 'ci' | 'rule'; group_window_minutes: number; max_incidents_per_hour: number; auto_resolve: boolean; hold_down_minutes: number;
  conditions: { min_severity?: string; sources?: string[]; check_contains?: string; ci_types?: string[]; environments?: string[]; max_ci_criticality?: number; include_unmatched?: boolean; min_count?: number };
}
export interface EventSource { id: number; name: string; kind: string; token_prefix: string; token_created_at: string; signed: boolean; ci_source_system: string; enabled: boolean; url: string; last_received_at: string | null; received_count: number; rejected_count: number }
export interface MaintenanceWindow { id: number; ci: string | null; ci_name: string | null; group_name: string | null; include_dependencies: boolean; starts_at: string; ends_at: string; reason: string; covered_cis: number; created_by: string }
