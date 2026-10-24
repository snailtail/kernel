/** /api/reports, /api/services/:ref/report, /api/report-schedules and /api/dashboard/kpis: reports, schedules and KPI tiles. */
export interface ProblemReport {
  period: { from: string; to: string; bucket: 'week' | 'month' };
  /** Problem management is on (#184); its fields are left out otherwise. */
  problems: boolean;
  summary: {
    opened: number; major_opened: number; known_errors_raised: number; resolved: number; closed: number;
    reopened: number; open_now: number; proactive: number; reactive: number;
  };
  flow: { bucket: string; opened: number; known_errors: number; resolved: number; closed: number }[];
  backlog: { at: string; open: number }[];
  lead_times: {
    priority: number; known_error_count: number; known_error_median_h: number | null; known_error_p90_h: number | null;
    resolved_count: number; resolved_median_h: number | null; resolved_p90_h: number | null;
  }[];
  closures: { closure_code: string; count: number }[];
  hotspots: {
    services: { name: string; incidents: number; events: number; open_problems: number }[];
    categories: { name: string; logged: number; open: number }[];
    cis: { ref: string; name: string; type_label: string; criticality: number; records: number; unlinked: number; open_problems: number; known_errors: number }[];
    ci_types: { name: string; records: number; problems: number }[];
  };
  sla: { overall: SlaCompliance; by_priority: (SlaCompliance & { priority: number })[]; by_group: (SlaCompliance & { name: string })[]; by_service: (SlaCompliance & { name: string })[] };
  changes: { requested: number; implemented: number; successful: number; failed: number; emergency: number; standard: number; followed_by_incidents: number };
  incidents: { opened: number; resolved: number; major: number; open_now: number; reopened: number; with_problem: number; mtta_median_min: number | null; mttr_median_h: number | null; reviews?: { major_resolved: number; reviewed: number; waived: number; reviewed_share: number | null; median_days_to_review: number | null }; by_ci: { ref: string; name: string; incidents: number; without_problem: number }[] };
  known_errors: { count: number; avg_age_days: number; with_workaround: number; with_decision: number; risk_accepted: number; review_due: number };
  actions: { created: number; completed: number; on_time_rate: number | null; open_now: number; overdue_now: number };
}
interface SlaCompliance { resolved: number; resolution_met: number; resolution_with_target: number; response_met: number; response_with_target: number }
export interface ServiceReport {
  service: { ref: string; name: string; criticality: number; sla: string | null; owner_id: number | null };
  period: { from: string; to: string; minutes: number };
  availability: { percent: number | null; target: number | null; outage_minutes: number; degraded_minutes: number; maintenance_minutes: number; basis: string };
  incidents: { total: number; by_priority: { priority: number; count: number }[]; resolution_sla: { met: number; of: number; percent: number } | null; mttr_minutes: number | null; linked_to_problems: number; major: { ref: string; title: string; created_at: string; resolved_at: string | null }[] };
  changes: { total: number; completed: number; successful: number; success_rate: number | null; failed: { ref: string; title: string; outcome: string }[] };
  problems: { ref: string; title: string; status: string; priority: number; workaround: string | null; workaround_masked?: boolean }[];
  restricted_records_left_out: boolean;
}
export interface ReportSchedule { id: number; frequency: 'monthly' | 'quarterly'; recipient: string; user_id: number; last_sent: string | null }
export interface KpiTile {
  id: string;
  label: string;
  value: number | null;
  unit: 'minutes' | 'percent' | 'count';
  trend: (number | null)[];
  trend_label: string;
  lower_is_better: boolean;
  detail: string;
  basis: string;
  link: string;
}
export interface KpiSummary { period: { unit: 'month' | 'week'; starts: string[] }; tiles: KpiTile[]; restricted_records_left_out: boolean }
