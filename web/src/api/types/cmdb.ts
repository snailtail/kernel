/** /api/cis (+ /:ref, /retire-proposals), /api/ci-types, /api/ci-groups, relationships and impact: configuration items and their graph. */
export interface CiType { name: string; label: string; class: 'ci' | 'service'; attributes: { key: string; label: string; type: 'string' | 'number' }[]; active: boolean }
interface CiSource { id: number; source_system: string; source_id: string; source_url: string; first_seen_at: string; last_seen_at: string }
interface CiLink { id: number; kind: string; reference: string; system: string; url: string; note: string }
interface CiActivity { id: number; kind: string; body: string; data: Record<string, unknown>; channel: string; created_at: string; user_name: string | null }
export interface Ci {
  id: number; ref: string; type: 'ci' | 'service'; class: 'ci' | 'service'; name: string; ci_type: string; type_label: string; status: string;
  environment: string; criticality: number; owner_id: number | null; owner: string | null; team: string; description: string;
  tags: string[]; attributes: Record<string, unknown>; created_at: string; updated_at: string; last_seen_at: string | null;
  has_end_users?: boolean; business_owner_id?: number | null; business_owner?: string | null; technical_contact_id?: number | null; technical_contact?: string | null;
  source_systems: string[] | null; url: string;
  sla_id?: number | null; user_description?: string; how_to_get_help?: string; in_catalogue?: boolean;
}
interface CiProblem { ref: string; title: string; status: string; priority: number; workaround?: string; workaround_effectiveness?: string | null; ec_decision?: string | null }
export interface CiDetail extends Ci { alerts: { id: number; source: string; check_key: string; severity: string; status: string; count: number; flap_count: number; last_seen: string; suppressed: string; incident_ref: string | null }[]; maintenance_windows: { id: number; starts_at: string; ends_at: string; reason: string }[]; incidents: { ref: string; title: string; status: string; priority: number }[]; problems: CiProblem[]; known_errors: CiProblem[]; recent_records: { system: string; kind: string; reference: string; summary: string; occurred_at: string; linked: boolean }[]; sources: CiSource[]; links: CiLink[]; activity: CiActivity[]; relationships: Relationship[]; groups: { id: number; name: string; purpose: string; membership: string }[] }
export interface RetireProposal {
  ref: string; class: 'ci' | 'service'; name: string; type_label: string; environment: string; owner: string | null; team: string;
  missing_since: string; retire_after_days: number; proposed_at: string; last_seen_at: string | null; can_retire: boolean;
  sources: { source_system: string; source_id: string; source_url: string; last_seen_at: string; connector: string | null }[];
  relationships: { type: string; direction: 'in' | 'out'; ref: string; name: string }[];
  open_records: { ref: string; kind: string; title: string }[];
}
export interface RetireResult { ref: string; outcome: 'retired' | 'unchanged' | 'skipped' | 'failed'; reason?: string }
export interface Relationship { id: number; type: string; direction: 'outgoing' | 'incoming'; label: string; ref: string; name: string; other_type: string; status: string; discovered_by: string | null; last_seen_at: string }
export interface RelationshipType { name: string; label: string; inverse_label: string; propagation: string }
export interface CiImpactNode { ref: string; name: string; type: 'ci' | 'service'; type_label: string; status: string; criticality: number; depth: number; via: string | null; relationship: { from: string; label: string; to: string } }
export interface CiImpact { meaning: string; truncated: boolean; depth_limit_reached: boolean; max_depth: number; max_nodes: number; count: number; nodes: CiImpactNode[]; services: { ref: string; name: string; criticality: number }[] }
export interface CiGroup { id: number; name: string; purpose: string; description: string; rules: { match: 'all' | 'any'; conditions: CiGroupCondition[] }; manual_members?: number }
export interface CiGroupCondition { field: string; key?: string; op: string; value: string }
export interface CiGroupDetail extends CiGroup { truncated: boolean; members: { ref: string; name: string; type: string; ci_type: string; status: string; criticality: number; team: string; manual: boolean; by_rule: boolean }[] }
export interface AffectedCi { ref: string; name: string; type: 'ci' | 'service'; type_label: string; status: string; criticality: number }
export interface AffectedService { ref: string; name: string; criticality: number; via: string[] }
export interface ImpactHint { suggested_impact: number; reason: string; incomplete: boolean }
