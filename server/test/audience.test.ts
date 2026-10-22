import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BROADEST, mayCopyText, PORTAL_INCIDENT_STATUS, PORTAL_REQUEST_STATUS, type Audience } from '../src/audience.js';

const a = (restricted: boolean, teams: number[], classification: Audience['classification'] = 'normal'): Audience => ({ ref: 'X', restricted, restricted_teams: teams, classification });

test('mayCopyText: never into a broader audience (#117)', () => {
  const cases: [string, Audience, Audience, boolean, ('text' | 'title')?][] = [
    ['normal → normal', a(false, []), a(false, []), true],
    ['normal → restricted', a(false, []), a(true, [1]), true],
    ['restricted → normal', a(true, [1]), a(false, []), false],
    ['restricted → everyone (article)', a(true, []), BROADEST, false],
    ['restricted {} → restricted {} (both only assignee and creator)', a(true, []), a(true, []), true],
    ['restricted {} → restricted {1}: a team is broader than nobody', a(true, []), a(true, [1]), false],
    ['restricted {1} → restricted {}: narrower', a(true, [1]), a(true, []), true],
    ['restricted {1} → restricted {1}', a(true, [1]), a(true, [1]), true],
    ['restricted {1} → restricted {1, 2}: one more team', a(true, [1]), a(true, [1, 2]), false],
    ['restricted {1, 2} → restricted {2}', a(true, [1, 2]), a(true, [2]), true],
    ['restricted {1} → restricted {2}', a(true, [1]), a(true, [2]), false],
    ['confidential → normal', a(false, [], 'confidential'), a(false, []), false],
    ['confidential → confidential', a(false, [], 'confidential'), a(false, [], 'confidential'), true],
    ['normal → confidential', a(false, []), a(false, [], 'confidential'), true],
    ['confidential title → normal (titles stay readable)', a(false, [], 'confidential'), a(false, []), true, 'title'],
    ['restricted title → normal', a(true, []), a(false, []), false, 'title'],
    ['restricted + confidential → restricted only', a(true, [1], 'confidential'), a(true, [1]), false],
  ];
  for (const [name, from, to, expected, kind] of cases) assert.equal(mayCopyText(from, to, kind), expected, name);
});

test('the portal names every status in plain words (#45)', () => {
  const jargon = /\b(incident|sla|priority|fulfil\w*|resolution|resolved|escalat\w*|triage|on hold|in progress)\b/i;
  for (const [statuses, labels] of [[['new', 'in_progress', 'on_hold', 'resolved', 'closed'], PORTAL_INCIDENT_STATUS], [['submitted', 'awaiting_approval', 'in_fulfilment', 'fulfilled', 'rejected', 'cancelled'], PORTAL_REQUEST_STATUS]] as const) {
    for (const s of statuses) {
      assert.ok(labels[s], `a label for ${s}`);
      assert.doesNotMatch(labels[s], jargon);
    }
  }
});
