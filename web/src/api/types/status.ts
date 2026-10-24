/** /api/status: the internal status board with its services, updates and planned maintenance. */
export type ServiceStatus = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance';
export interface StatusService {
  id: number; ref: string; name: string; criticality: number; status: ServiceStatus; suggested: ServiceStatus; incidents: { ref: string; priority: number; major: boolean }[];
  public: boolean; public_name: string; public_description: string; public_status: ServiceStatus; updated_at: string | null; updated_by: string | null; following: boolean;
}
interface StatusUpdate {
  id: number; phase: string; status: ServiceStatus | null; message: string; public: boolean; retracted_at: string | null; created_at: string; incident: string | null; author: string | null; services: string[] | null;
  /** Mail to people outside: subscribers and organisation contacts. */
  outside: { sent: number; pending: number; failed: number } | null;
}
export interface StatusBoard { services: StatusService[]; updates: StatusUpdate[]; planned_maintenance: { ref: string; title: string; planned_start: string; planned_end: string; service: string }[]; settings: StatusSettings }
export interface StatusSettings { public_enabled: boolean; title: string; sign_up: boolean }
