/** /api/candidates: problem candidates, their evidence and rules, and end-of-life versions. */
export type CandidateRuleId = 'recurring_records' | 'common_upstream' | 'major_without_problem' | 'recurring_resolution' | 'reported'
  | 'flapping' | 'rising_warnings' | 'capacity_warnings' | 'self_clearing' | 'change_correlation'
  | 'repeatedly_missing' | 'eol_versions' | 'single_point_of_failure';
export interface EvidenceRecord {
  key: string; kind: 'incident' | 'event' | 'external' | 'change' | 'ci' | 'sync'; id: number | null; incident_ref: string | null; alert_id: number | null; change_ref?: string | null; system: string; reference: string;
  summary: string; category: string; occurred_at: string | null; ci_ref: string | null; resolution_code?: string | null; url?: string | null; note?: string | null;
}
export interface CandidateSeries { label: string; unit: string; points: { day: string; value: number }[]; split?: string }
export interface Candidate {
  key: string; rule: CandidateRuleId; rule_label: string; proactive: boolean; reason: string; subject: { type: string; ref: string | null; name: string };
  service: string; ci_ref: string | null; source?: string; contains_personal_data?: boolean; count: number; incidents: number; events: number; first_at: string | null; last_at: string | null;
  evidence: { records: EvidenceRecord[]; total_records: number; series?: CandidateSeries[]; cis: { ref: string; name: string; role: 'subject' | 'upstream' | 'affected'; depth?: number }[]; notes?: string };
  decision?: { decision: 'dismissed' | 'snoozed'; until: string | null; reason: string; by: string | null; at: string };
}
export interface CandidateRule { rule: CandidateRuleId; label: string; description: string; enabled: boolean; settings: Record<string, number>; count: number; error?: string }
export interface CandidateList { rules: CandidateRule[]; hidden: { dismissed: number; snoozed: number }; candidates: Candidate[] }
export interface EolVersion { id: number; product: string; version: string; eol_date: string; note: string }
export interface CandidateDraft { title: string; description: string; affected_service: string; detection: 'reactive' | 'proactive'; ci_refs: string[]; records: number }
