// Modules (#36): practices a team can switch off to keep Kernel simple. The switch is enforced in one place – the
// policy layer – so a disabled module's REST routes answer 404, its MCP tools and prompts are not listed, its record
// types drop out of search, and its background work stops. Nothing is deleted; switching back on restores it all.
import { query } from './db.js';

export const MODULES = {
  incident: { label: 'Incidents', description: 'Log and restore service for disruptions, with SLAs and hand-over to problem management.' },
  change: { label: 'Changes', description: 'Assess, authorise and schedule changes; standard changes from pipelines.' },
  event: { label: 'Events from monitoring', description: 'Receive alerts from Alertmanager, Uptime Kuma, Azure Monitor, OP5…; rules open incidents.' },
  cmdb: { label: 'CMDB', description: 'Configuration items and services, relationships and impact analysis.' },
  sla: { label: 'Service levels', description: 'SLAs, business hours and the service catalogue; SLA clocks on incidents.' },
  knowledge: { label: 'Knowledge', description: 'Articles from known errors and resolutions, suggested while logging incidents.' },
} as const;
export type Module = keyof typeof MODULES;

let state: Record<Module, boolean> = { incident: true, change: true, event: true, cmdb: true, sla: true, knowledge: true };
let loadedAt = 0;

/** Reloads the module switches (on start, after a change, and every 30 s so replicas follow). */
export async function refreshModules() {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'modules'");
  state = { ...state, ...(rows[0]?.value ?? {}) };
  loadedAt = Date.now();
  return state;
}

export const modules = () => {
  if (Date.now() - loadedAt > 30_000) refreshModules().catch(() => {});
  return state;
};

export const moduleEnabled = (m: Module) => modules()[m] !== false;

/** The module an action belongs to; problem management and administration belong to none (always on). */
export function moduleOfAction(action: string): Module | null {
  const prefix = action.split('.')[0];
  if (prefix === 'incident' || prefix === 'change' || prefix === 'event' || prefix === 'sla') return prefix;
  if (prefix === 'ci') return 'cmdb';
  if (prefix === 'article') return 'knowledge';
  return null;
}

export const actionEnabled = (action: string) => {
  const m = moduleOfAction(action);
  return !m || moduleEnabled(m);
};

/** OpenAPI tags and MCP prompts per module, so the documentation and agent surface follow the switches too. */
export const MODULE_TAGS: Record<string, Module> = { Incidents: 'incident', Changes: 'change', Events: 'event', CMDB: 'cmdb', 'Service levels': 'sla' };
