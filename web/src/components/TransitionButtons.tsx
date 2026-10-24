/** One button in a record's header: a status move or another next step. Hidden when `show` is false. */
export interface Transition {
  label: string;
  onClick: () => void;
  tone?: 'primary' | 'danger';
  show?: boolean;
}

/** The row of next-step buttons under a record's title, in the order given. */
export function TransitionButtons({ buttons }: { buttons: Transition[] }) {
  return (
    <div className="transitions">
      {buttons.filter((b) => b.show !== false).map((b, n) => (
        <button key={`${n}-${b.label}`} className={b.tone ? `btn ${b.tone}` : 'btn'} onClick={b.onClick}>{b.label}</button>
      ))}
    </div>
  );
}
