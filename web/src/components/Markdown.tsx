// A small Markdown renderer that builds React elements directly (never HTML strings), so user text cannot inject
// markup. Supports headings, paragraphs, lists, blockquotes, code blocks, tables, bold, italic, inline code and
// http(s)/mailto links — enough for problem records and work notes.
import type { ReactNode } from 'react';

// http(s), mailto and app-relative paths; not protocol-relative (//host) or backslash tricks (/\host).
const SAFE_URL = /^(https?:\/\/|mailto:|\/(?![\/\\]))/i;

function inline(text: string, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  // Order matters: code first (its content is literal), then links, bold, italic.
  const pattern = /(`[^`]+`)|\[([^\]]+)\]\(([^)\s]+)\)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}${i++}`;
    if (m[1]) out.push(<code key={key}>{m[1].slice(1, -1)}</code>);
    else if (m[2] !== undefined) {
      out.push(SAFE_URL.test(m[3]) ? <a key={key} href={m[3]} target="_blank" rel="noreferrer noopener">{inline(m[2], key)}</a> : m[0]);
    } else if (m[4]) out.push(<strong key={key}>{inline(m[4].slice(2, -2), key)}</strong>);
    else if (m[5]) out.push(<em key={key}>{inline(m[5].slice(1, -1), key)}</em>);
    else if (m[6]) out.push(<a key={key} href={m[6]} target="_blank" rel="noreferrer noopener">{m[6]}</a>);
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Inline content with explicit line breaks preserved (single newlines inside a paragraph). */
function lines(text: string, key: string): ReactNode[] {
  return text.split('\n').flatMap((line, i) => (i ? [<br key={`${key}br${i}`} />, ...inline(line, `${key}l${i}`)] : inline(line, `${key}l${i}`)));
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const src = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `b${k++}`;

  while (i < src.length) {
    const line = src[i];
    if (!line.trim()) { i++; continue; }

    // Horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key()} />);
      i++;
      continue;
    }

    // Fenced code block
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < src.length && !src[i].trim().startsWith(fence[1])) body.push(src[i++]);
      i++;
      blocks.push(<pre key={key()}><code>{body.join('\n')}</code></pre>);
      continue;
    }

    // Heading (rendered one level down, as fields already have their own heading)
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(6, h[1].length + 2);
      const Tag = `h${level}` as 'h3';
      blocks.push(<Tag key={key()}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < src.length && src[i].startsWith('>')) body.push(src[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={key()}><Markdown text={body.join('\n')} /></blockquote>);
      continue;
    }

    // Table: header row, separator row, body rows
    if (line.includes('|') && i + 1 < src.length && TABLE_SEP.test(src[i + 1])) {
      const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < src.length && src[i].includes('|') && src[i].trim()) rows.push(cells(src[i++]));
      blocks.push(
        <div className="table-wrap" key={key()}>
          <table>
            <thead><tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? '')}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    // List (one level of nesting by indentation)
    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: { text: string; checked: boolean | null; children: string[] }[] = [];
      const baseIndent = line.match(/^\s*/)![0].length;
      while (i < src.length && (LIST_ITEM.test(src[i]) || (src[i].startsWith('  ') && items.length && src[i].trim()))) {
        const m = src[i].match(LIST_ITEM);
        const indent = src[i].match(/^\s*/)![0].length;
        if (m && indent <= baseIndent + 1) {
          items.push({ text: m[4], checked: m[3] ? /x/i.test(m[3]) : null, children: [] });
        } else {
          items[items.length - 1].children.push(src[i].slice(Math.min(indent, baseIndent + 2)));
        }
        i++;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={key()}>
          {items.map((it, j) => (
            <li key={j} className={it.checked !== null ? 'task' : undefined}>
              {it.checked !== null && <input type="checkbox" checked={it.checked} readOnly disabled />}
              {inline(it.text, `li${j}`)}
              {it.children.length > 0 && <Markdown text={it.children.join('\n')} />}
            </li>
          ))}
        </Tag>,
      );
      continue;
    }

    // Paragraph: consecutive lines until a blank line or another block starts
    const para: string[] = [];
    while (
      i < src.length && src[i].trim() && !/^(#{1,6}\s|>|\s*(```|~~~))/.test(src[i]) && !LIST_ITEM.test(src[i]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(src[i]) &&
      !(src[i].includes('|') && i + 1 < src.length && TABLE_SEP.test(src[i + 1]))
    ) para.push(src[i++]);
    if (!para.length) para.push(src[i++]); // never stall on an unrecognised line
    const pk = key();
    blocks.push(<p key={pk}>{lines(para.join('\n'), pk)}</p>);
  }
  return <div className={`markdown ${className}`}>{blocks}</div>;
}
