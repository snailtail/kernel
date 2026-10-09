// Paste and drop into a record's text fields (#74): screenshots become attachments shown inline, formatted text
// (Outlook, Teams, Confluence, web pages) becomes Markdown, and log output becomes a code block. Shift+paste (or
// Ctrl+Shift+V) keeps plain text. Markdown stays the stored format.
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react';
import { uploadAttachment } from './Attachments';

const LOG_LINE = /^(\[?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\d{2}:\d{2}:\d{2}|at\s+\S+\(|Traceback|File \"|\S*(Exception|Error)\b|(ERROR|WARN(ING)?|INFO|DEBUG|FATAL)\b)/;

/** Several lines that mostly look like log or stack trace output. */
export function looksLikeLog(text: string) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2 || text.includes('```')) return false;
  return lines.filter((l) => LOG_LINE.test(l.trimStart())).length >= Math.max(2, lines.length / 2);
}

/** HTML from the clipboard as Markdown. Images that are not attachments are dropped (no hot-linking, no tracking). */
export async function htmlToMarkdown(html: string) {
  const [{ default: TurndownService }, gfm] = await Promise.all([import('turndown'), import('@joplin/turndown-plugin-gfm')]);
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  td.use((gfm as any).gfm ?? (gfm as any).default?.gfm);
  td.remove(['script', 'style', 'meta', 'link', 'head', 'title', 'noscript', 'iframe', 'object', 'form'] as any);
  td.addRule('no-external-images', { filter: 'img', replacement: () => '' });
  // Only links a reader can follow safely.
  td.addRule('safe-links', {
    filter: (node) => node.nodeName === 'A',
    replacement: (content, node) => {
      const href = (node as HTMLAnchorElement).getAttribute('href') ?? '';
      return /^(https?:|mailto:)/i.test(href) && content.trim() ? `[${content}](${href})` : content;
    },
  });
  // Turndown pads list markers ("-   item"); one space reads better in the editor.
  return td.turndown(html).replace(/^(\s*)([-*]|\d+\.)\s{2,}/gm, '$1$2 ').replace(/\n{3,}/g, '\n\n').trim();
}

type Setter = (next: string) => void;

function insertAt(el: HTMLTextAreaElement, text: string, set: Setter) {
  const { selectionStart: a, selectionEnd: b, value } = el;
  const next = value.slice(0, a) + text + value.slice(b);
  set(next);
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = a + text.length;
  });
}

/**
 * Props for a <textarea>: pass the record ref (null while the record does not exist yet: images are then refused
 * with a hint) and the setter of the field's value.
 */
export function richPaste(recordRef: string | null, set: Setter, onError: (message: string | null) => void = () => {}) {
  let plain = false;
  const uploadAll = async (el: HTMLTextAreaElement, files: File[]) => {
    if (!recordRef) return onError('Save the record first, then paste or drop images and files.');
    onError(null);
    for (const f of files) {
      const placeholder = `![Uploading ${f.name || 'image'}…]()`;
      insertAt(el, placeholder, set);
      try {
        const a = await uploadAttachment(recordRef, f, f.name && f.name !== 'image.png' ? f.name : `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`);
        const md = a.kind === 'image' ? `![${a.filename}](attachment:${a.id})` : `[${a.filename}](attachment:${a.id})`;
        set(el.value.replace(placeholder, md));
      } catch (err) {
        set(el.value.replace(placeholder, ''));
        onError(`${f.name}: ${(err as Error).message}`);
      }
    }
  };
  return {
    onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => {
      plain = e.shiftKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v';
    },
    onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      const files = Array.from(e.clipboardData.files);
      if (files.length) {
        e.preventDefault();
        uploadAll(el, files);
        return;
      }
      if (plain) {
        plain = false;
        return; // the browser pastes plain text
      }
      const html = e.clipboardData.getData('text/html');
      const text = e.clipboardData.getData('text/plain');
      if (html && /<(p|div|br|table|ul|ol|h\d|b|strong|i|em|a|pre|code)\b/i.test(html)) {
        e.preventDefault();
        htmlToMarkdown(html).then((md) => insertAt(el, md || text, set), () => insertAt(el, text, set));
      } else if (looksLikeLog(text)) {
        e.preventDefault();
        insertAt(el, `\n\`\`\`\n${text.replace(/\n+$/, '')}\n\`\`\`\n`, set);
      }
    },
    onDrop: (e: DragEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      uploadAll(e.currentTarget, files);
    },
  };
}
