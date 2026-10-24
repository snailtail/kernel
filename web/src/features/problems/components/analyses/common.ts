import { type Technique } from '../../../../api/client';

export const TECHNIQUE_LABEL: Record<Technique, string> = {
  five_whys: '5 Whys',
  ishikawa: 'Ishikawa',
  kepner_tregoe: 'Kepner-Tregoe',
  timeline: 'Timeline',
};

export const TECHNIQUE_HINT: Record<Technique, string> = {
  five_whys: 'Ask "why?" until you reach a cause that, if removed, prevents recurrence.',
  ishikawa: 'Brainstorm possible causes per category. One cause per line.',
  kepner_tregoe: 'Compare what IS affected with what could be but IS NOT, then test possible causes against both.',
  timeline: 'Line up incidents, changes, deployments and alerts to find what changed before the problem started.',
};

export interface EditorProps {
  data: any;
  set: (d: any) => void;
  readOnly: boolean;
}

/** Immutable update helpers for nested arrays. */
export const replaceAt = <T,>(list: T[], i: number, value: T) => list.map((x, j) => (j === i ? value : x));
export const removeAt = <T,>(list: T[], i: number) => list.filter((_, j) => j !== i);
