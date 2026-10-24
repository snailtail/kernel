import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client';
import { Markdown } from '../../components/Markdown';

/** Print-friendly rendering of the problem's Markdown export (use the browser's Print → Save as PDF). */
export function ProblemPrintPage() {
  const { ref } = useParams();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.text(`/api/problems/${ref}/export.md`).then(setText, () => setError(`Could not load ${ref}`));
  }, [ref]);
  return (
    <article className="print-page">
      <div className="actions no-print">
        <Link to={`/problems/${ref}`} className="btn-link spacer-right">← Back to {ref}</Link>
        <a className="btn" href={`/api/problems/${ref}/export.md`}>Download Markdown</a>
        <button className="btn primary" onClick={() => window.print()}>Print / save as PDF</button>
      </div>
      {error && <div className="error">{error}</div>}
      {text && <section className="card document"><Markdown text={text} /></section>}
    </article>
  );
}
