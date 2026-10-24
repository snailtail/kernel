/** /api/people and /api/organisations: people, their record page and organisations; PersonRef is what incidents and requests accept. */
export interface Person {
  id: number; name: string; email: string | null; phone: string; title: string; department: string; location: string;
  organisation_id: number | null; organisation: string | null; manager_id: number | null; manager: string | null;
  is_vip: boolean; status_contact: boolean; active: boolean; external_id: string | null; source: string; user_id: number | null; erased_at: string | null;
}
export interface PersonDetail extends Person {
  incidents: { ref: string; title: string; status: string; priority: number; created_at: string; role: string }[];
  services: { ref: string; name: string; criticality: number }[];
  owns: { ref: string; name: string; class: string; role: string }[];
}
export interface Organisation { id: number; name: string; kind: 'internal' | 'customer'; description: string; active: boolean; people: number; services: { ref: string; name: string }[] }
export interface PersonLite { id: number; name: string; email: string | null; is_vip: boolean; organisation: string | null; erased?: boolean; phone?: string }
export type PersonRef = { id: number; label?: string } | { name: string; email?: string };
