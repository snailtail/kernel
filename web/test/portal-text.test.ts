import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AFFECTED, TEXT } from '../src/portal/text.js';

// People outside IT should not need these words (#45). "Problem", "request" and "ticket" are plain enough.
const JARGON = /\b(incident|itil|sla|priority|impact|urgency|ci|cmdb|configuration item|fulfil\w*|resolution|resolved|escalat\w*|assignee|triage|known error|workaround|caller|requester|service request|change request|kernel)\b/i;

const sentences = [
  ...Object.values(TEXT).map((v) => (typeof v === 'function' ? v('Eva Example') : v)),
  ...AFFECTED.map((a) => a.label),
];

test('the portal speaks plain language: no ITSM terms in anything it shows', () => {
  for (const s of sentences) assert.doesNotMatch(s, JARGON, s);
});

test('the portal page shows no text outside the TEXT table (except refs, dates and names from the server)', () => {
  const src = readFileSync(new URL('../src/portal/Portal.tsx', import.meta.url), 'utf8');
  // Prose written straight between JSX tags (words with spaces), rather than taken from TEXT.
  const literal = [...src.matchAll(/>([^<>{}]+)</g)].map((m) => m[1].trim()).filter((t) => /^[A-Za-z][A-Za-z ,.'!?]* [A-Za-z]/.test(t));
  assert.deepEqual(literal, []);
});
