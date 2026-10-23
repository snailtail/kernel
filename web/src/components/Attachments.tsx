import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { formatDate } from '../format';
import { AnalyzeLogButton } from './Ai';
import { Modal } from './Modal';

export interface Attachment {
  id: number; record_ref: string; filename: string; kind: 'image' | 'pdf' | 'text' | 'file'; content_type: string; size: number;
  width: number | null; height: number | null; flags: string[]; created_at: string; uploaded_by: number | null; uploaded_by_name: string | null;
}

const CHANGED = 'kernel:attachments-changed';
const FLAG_TEXT: Record<string, string> = {
  credential: 'may contain a password or key',
  token: 'may contain an access token',
  private_key: 'contains a private key',
  personal_identity_number: 'may contain a personal identity number',
};

const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Uploads a file to a record; the server decides the type from the content. */
export async function uploadAttachment(recordRef: string, file: Blob, filename: string): Promise<Attachment> {
  const res = await fetch(`/api/records/${recordRef}/attachments?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Kernel-Request': '1', 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data ?? {});
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: recordRef }));
  return data;
}

/** Files and screenshots on a record: drop or pick files, and preview images, PDFs and logs in place. */
export function AttachmentsPanel({ recordRef, editable, canDelete }: { recordRef: string; editable: boolean; canDelete: (a: Attachment) => boolean }) {
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<Attachment | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(() => api.get<Attachment[]>(`/api/records/${recordRef}/attachments`).then(setItems, (err) => setError(err.message)), [recordRef]);
  useEffect(() => {
    load();
    const onChange = (e: Event) => (e as CustomEvent).detail === recordRef && load();
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, [load, recordRef]);
  const upload = async (files: FileList | File[]) => {
    setError(null);
    for (const f of Array.from(files)) {
      setBusy((n) => n + 1);
      try {
        await uploadAttachment(recordRef, f, f.name || 'pasted');
      } catch (err) {
        setError(`${f.name}: ${(err as Error).message}`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };
  const remove = async (a: Attachment) => {
    if (!window.confirm(`Remove ${a.filename}? The file is deleted.`)) return;
    try {
      await api.del(`/api/attachments/${a.id}`);
      setOpen(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const images = items?.filter((a) => a.kind === 'image') ?? [];
  const others = items?.filter((a) => a.kind !== 'image') ?? [];
  return (
    <section
      className={`card attachments ${dragging ? 'dragging' : ''}`}
      onDragOver={editable ? (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } } : undefined}
      onDragLeave={() => setDragging(false)}
      onDrop={editable ? (e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); } : undefined}
    >
      <h2>Attachments {items && items.length > 0 && <span className="muted small">{items.length}</span>}</h2>
      {items?.length === 0 && <p className="placeholder">{editable ? 'Drop files here, or paste a screenshot into a text field.' : 'No attachments.'}</p>}
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((a) => (
            <button key={a.id} type="button" className="thumb" onClick={() => setOpen(a)} title={a.filename}>
              <img src={`/api/attachments/${a.id}/thumb`} alt={a.filename} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="plain-list att-list">
          {others.map((a) => (
            <li key={a.id}>
              <button type="button" className="link-btn" onClick={() => setOpen(a)}>{a.filename}</button>
              <span className="muted small"> {a.kind === 'file' ? 'file' : a.kind.toUpperCase()} · {fileSize(a.size)}</span>
              {a.flags.length > 0 && <span className="flag-warn" title={a.flags.map((f) => FLAG_TEXT[f] ?? f).join('; ')}> ⚠</span>}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="att-actions">
          <button type="button" className="btn small" onClick={() => input.current?.click()}>Attach files</button>
          {busy > 0 && <span className="muted small">Uploading…</span>}
          <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ''; }} />
        </div>
      )}
      {error && <div className="error small">{error}</div>}
      {open && <AttachmentViewer attachment={open} siblings={items ?? []} onSelect={setOpen} onClose={() => setOpen(null)} onDelete={canDelete(open) && editable ? () => remove(open) : undefined} />}
    </section>
  );
}

/** A full-size view of one attachment, with the left/right keys moving between them. */
function AttachmentViewer({ attachment: a, siblings, onSelect, onClose, onDelete }: { attachment: Attachment; siblings: Attachment[]; onSelect: (a: Attachment) => void; onClose: () => void; onDelete?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const i = siblings.findIndex((s) => s.id === a.id);
      if (e.key === 'ArrowRight' && i >= 0 && i < siblings.length - 1) onSelect(siblings[i + 1]);
      if (e.key === 'ArrowLeft' && i > 0) onSelect(siblings[i - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [a, siblings, onSelect]);
  return (
    <Modal title={a.filename} onClose={onClose}>
      <div className="att-viewer">
        {a.kind === 'image' && (
          <a href={`/api/attachments/${a.id}?inline=1`} target="_blank" rel="noreferrer" title="Open the original">
            <img className="att-image" src={`/api/attachments/${a.id}/preview`} alt={a.filename} />
          </a>
        )}
        {a.kind === 'pdf' && <iframe className="att-pdf" title={a.filename} src={`/api/attachments/${a.id}?inline=1`} sandbox="allow-same-origin allow-scripts" />}
        {a.kind === 'text' && <TextViewer attachment={a} />}
        {a.kind === 'text' && <AnalyzeLogButton attachmentId={a.id} />}
        {a.kind === 'file' && <p className="muted">This file type can only be downloaded.</p>}
        {a.flags.length > 0 && <p className="hint-box">⚠ This file {a.flags.map((f) => FLAG_TEXT[f] ?? f).join(', and ')}. Remove secrets and personal data that are not needed.</p>}
        <div className="att-meta muted small">
          {fileSize(a.size)}{a.width ? ` · ${a.width}×${a.height}` : ''} · added {formatDate(a.created_at)}{a.uploaded_by_name ? ` by ${a.uploaded_by_name}` : ''}
        </div>
        <div className="actions">
          {onDelete && <button type="button" className="btn danger small" onClick={onDelete}>Remove</button>}
          <a className="btn small" href={`/api/attachments/${a.id}`} download>Download</a>
        </div>
      </div>
    </Modal>
  );
}

interface TextPage { total_lines: number; from: number; lines: string[]; first_error_line: number | null }
const PAGE = 2000;

/** Logs, configuration and CSV in place: line numbers, search, wrap, and a jump to the first error. */
function TextViewer({ attachment: a }: { attachment: Attachment }) {
  const [lines, setLines] = useState<string[]>([]);
  const [meta, setMeta] = useState<TextPage | null>(null);
  const [q, setQ] = useState('');
  const [wrap, setWrap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const more = useCallback(async (from: number) => {
    try {
      const page = await api.get<TextPage>(`/api/attachments/${a.id}/text?from=${from}&limit=${PAGE}`);
      setMeta(page);
      setLines((cur) => (from === 0 ? page.lines : [...cur, ...page.lines]));
      return page;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, [a.id]);
  useEffect(() => {
    setLines([]);
    more(0);
  }, [more]);
  const jump = async (line: number) => {
    while (line >= lines.length && meta && lines.length < meta.total_lines) {
      const page = await more(lines.length);
      if (!page?.lines.length) break;
    }
    requestAnimationFrame(() => box.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' }));
  };
  const needle = q.trim().toLowerCase();
  const matches = useMemo(() => (needle ? lines.reduce<number[]>((acc, l, i) => (l.toLowerCase().includes(needle) ? [...acc, i] : acc), []) : []), [lines, needle]);
  const csv = /\.csv$/i.test(a.filename) && lines.length > 1 && lines[0].includes(',');
  if (error) return <div className="error">{error}</div>;
  if (csv) return <CsvTable lines={lines} />;
  return (
    <div className="text-viewer">
      <div className="tv-tools">
        <input placeholder="Find…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find in file" />
        {needle && <span className="muted small">{matches.length} lines</span>}
        {needle && matches.length > 0 && <button type="button" className="btn small" onClick={() => jump(matches[0])}>First match</button>}
        {meta?.first_error_line != null && <button type="button" className="btn small" onClick={() => jump(meta.first_error_line!)}>First error</button>}
        <label className="check small"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap</label>
      </div>
      <div ref={box} className={`tv-lines ${wrap ? 'wrap' : ''}`}>
        {lines.map((l, i) => (
          <div key={i} data-line={i} className={`tv-line ${needle && l.toLowerCase().includes(needle) ? 'hit' : ''} ${i === meta?.first_error_line ? 'err' : ''}`}>
            <span className="tv-no">{i + 1}</span>
            <span className="tv-text">{l || ' '}</span>
          </div>
        ))}
      </div>
      {meta && lines.length < meta.total_lines && (
        <button type="button" className="btn small" onClick={() => more(lines.length)}>Load more ({meta.total_lines - lines.length} lines left)</button>
      )}
    </div>
  );
}

function splitCsv(line: string) {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

function CsvTable({ lines }: { lines: string[] }) {
  const rows = lines.filter((l) => l.trim()).slice(0, 1001).map(splitCsv);
  return (
    <div className="table-wrap tv-csv">
      <table className="table">
        <thead><tr>{rows[0].map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{rows.slice(1).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
      {lines.length > 1001 && <p className="muted small">The first 1,000 rows are shown. Download the file for all rows.</p>}
    </div>
  );
}
