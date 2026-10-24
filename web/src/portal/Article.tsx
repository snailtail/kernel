import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api/client';
import { Markdown } from '../components/Markdown';
import { TEXT } from './text';
import { Notice } from './common';

export function Article() {
  const { ref = '' } = useParams();
  const [a, setA] = useState<{ title: string; body: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<{ title: string; body: string }>(`/api/portal/articles/${ref}`).then(setA, () => setError(TEXT.notFound));
  }, [ref]);
  return (
    <>
      <p><Link to="/portal/report">← {TEXT.back}</Link></p>
      {error ? <Notice kind="error">{error}</Notice> : !a ? <p className="portal-muted" role="status">{TEXT.loading}</p> : (
        <article className="portal-card">
          <h1>{a.title}</h1>
          <Markdown text={a.body} />
          <p className="portal-muted">{TEXT.articleFooter} <Link to="/portal/report">{TEXT.reportButton}</Link></p>
        </article>
      )}
    </>
  );
}
