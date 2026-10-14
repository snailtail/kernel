import { useState } from 'react';

/** Text to copy (a command, a manifest), with a Copy button that never submits a surrounding form. */
export function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-block">
      <pre>{text}</pre>
      <button type="button" className="btn small" onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
