import type { PresencePerson } from '../live';

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

/** Who else has this record open – a hint, not a lock. */
export function Presence({ people }: { people: PresencePerson[] }) {
  if (!people.length) return null;
  const editing = people.filter((p) => p.editing);
  const label = editing.length
    ? `${editing.map((p) => p.name).join(', ')} ${editing.length === 1 ? 'is' : 'are'} editing`
    : `${people.map((p) => p.name).join(', ')} also ${people.length === 1 ? 'has' : 'have'} this open`;
  return (
    <div className="presence" role="status" aria-live="polite">
      <span className="presence-avatars" aria-hidden="true">
        {people.slice(0, 4).map((p) => <span key={p.name} className={`avatar${p.editing ? ' editing' : ''}`} title={p.name}>{initials(p.name)}</span>)}
      </span>
      <span className="muted small">{label}</span>
    </div>
  );
}
