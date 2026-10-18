import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { azureDevOps } from '../src/dev-azure.js';
import { github } from '../src/dev-github.js';
import { gitlab } from '../src/dev-gitlab.js';
import { ciState, refsIn, sameSecret, type Adapter } from '../src/dev-platform.js';

const parse = (adapter: Adapter, url: string, bases: string[] = []) => adapter.parseUrl(new URL(url), bases);
const req = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;
const pick = (i: any) => i && { repo: i.repo, item_type: i.item_type, key: i.key, url: i.url };

describe('dev platform adapters (#32)', () => {
  test('GitHub links parse as before', () => {
    assert.deepEqual(pick(parse(github, 'https://github.com/acme/shop/pull/12/files')), { repo: 'acme/shop', item_type: 'pull_request', key: '12', url: 'https://github.com/acme/shop/pull/12' });
    assert.equal(parse(github, 'https://github.com/acme/shop/releases/tag/v1.2')?.key, 'v1.2');
    assert.equal(parse(github, 'https://gitlab.com/acme/shop/-/merge_requests/1'), null, 'not GitHub');
    assert.throws(() => parse(github, 'https://github.com/acme/shop/pull/abc'), /no number/);
  });

  test('GitLab: every link type, nested groups, work items and a self-hosted GitLab under a path', () => {
    assert.deepEqual(pick(parse(gitlab, 'https://gitlab.com/acme/platform/shop/-/merge_requests/7/diffs')), { repo: 'acme/platform/shop', item_type: 'pull_request', key: '7', url: 'https://gitlab.com/acme/platform/shop/-/merge_requests/7' });
    assert.equal(parse(gitlab, 'https://gitlab.com/acme/shop/-/issues/3')?.item_type, 'issue');
    assert.deepEqual(pick(parse(gitlab, 'https://gitlab.com/acme/shop/-/work_items/4')), { repo: 'acme/shop', item_type: 'issue', key: '4', url: 'https://gitlab.com/acme/shop/-/issues/4' });
    assert.equal(parse(gitlab, `https://gitlab.com/acme/shop/-/commit/${'c'.repeat(40)}`)?.item_type, 'commit');
    assert.equal(parse(gitlab, 'https://gitlab.com/acme/shop/-/pipelines/991')?.item_type, 'workflow_run');
    assert.equal(parse(gitlab, 'https://gitlab.com/acme/shop/-/releases/v2.0')?.key, 'v2.0');
    assert.equal(parse(gitlab, 'https://git.example.com/acme/shop/-/merge_requests/1'), null, 'an unknown host is not GitLab');
    const self = parse(gitlab, 'https://git.example.com/gitlab/ops/kernel/-/merge_requests/5', ['https://git.example.com/gitlab']);
    assert.deepEqual(pick(self), { repo: 'ops/kernel', item_type: 'pull_request', key: '5', url: 'https://git.example.com/gitlab/ops/kernel/-/merge_requests/5' });
    assert.equal(self?.base, 'https://git.example.com/gitlab');
    assert.throws(() => parse(gitlab, 'https://gitlab.com/acme/shop/-/merge_requests/x'), /no number/);
    assert.throws(() => parse(gitlab, 'https://gitlab.com/acme/shop/-/tree/main'), /Not a link/);
  });

  test('Azure DevOps: dev.azure.com and visualstudio.com links, projects with spaces', () => {
    assert.deepEqual(pick(parse(azureDevOps, 'https://dev.azure.com/contoso/Web%20Shop/_git/shop/pullrequest/42?_a=files')), {
      repo: 'contoso/Web Shop', item_type: 'pull_request', key: '42', url: 'https://dev.azure.com/contoso/Web%20Shop/_git/shop/pullrequest/42',
    });
    assert.deepEqual(parse(azureDevOps, 'https://dev.azure.com/contoso/Shop/_git/shop/pullrequest/42')?.data, { repository: 'shop' });
    assert.deepEqual(pick(parse(azureDevOps, 'https://contoso.visualstudio.com/DefaultCollection/Shop/_workitems/edit/77')), { repo: 'contoso/Shop', item_type: 'issue', key: '77', url: 'https://dev.azure.com/contoso/Shop/_workitems/edit/77' });
    assert.equal(parse(azureDevOps, `https://contoso.visualstudio.com/Shop/_git/shop/commit/${'a'.repeat(40)}`)?.item_type, 'commit');
    assert.deepEqual(pick(parse(azureDevOps, 'https://dev.azure.com/contoso/Shop/_build/results?buildId=1234&view=results')), { repo: 'contoso/Shop', item_type: 'workflow_run', key: '1234', url: 'https://dev.azure.com/contoso/Shop/_build/results?buildId=1234' });
    assert.equal(parse(azureDevOps, 'https://dev.azure.com/contoso/Shop/_releaseProgress?releaseId=9&_a=release-pipeline-progress')?.item_type, 'release');
    assert.equal(parse(azureDevOps, 'https://github.com/a/b/pull/1'), null);
    assert.throws(() => parse(azureDevOps, 'https://dev.azure.com/contoso/Shop/_boards/board'), /Not a link/);
  });

  test('deliveries are verified: GitHub HMAC, GitLab token, Azure DevOps Basic password', () => {
    const raw = '{"a":1}';
    const sig = `sha256=${createHmac('sha256', 's3cret').update(raw).digest('hex')}`;
    assert.ok(github.verify(req({ 'x-hub-signature-256': sig }), raw, 's3cret'));
    assert.ok(!github.verify(req({ 'x-hub-signature-256': sig }), '{"a":2}', 's3cret'), 'the signature covers the body');
    assert.ok(gitlab.verify(req({ 'x-gitlab-token': 's3cret' }), raw, 's3cret'));
    assert.ok(!gitlab.verify(req({ 'x-gitlab-token': 's3cre' }), raw, 's3cret'));
    assert.ok(!gitlab.verify(req({}), raw, 's3cret'));
    const basic = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
    assert.ok(azureDevOps.verify(req({ authorization: basic('kernel:s3cret') }), raw, 's3cret'));
    assert.ok(azureDevOps.verify(req({ authorization: basic('anyone:s3cret') }), raw, 's3cret'), 'the user name is not part of the secret');
    assert.ok(!azureDevOps.verify(req({ authorization: basic('kernel:wrong') }), raw, 's3cret'));
    assert.ok(!azureDevOps.verify(req({ authorization: basic('s3cret') }), raw, 's3cret'), 'no colon, no password');
    assert.ok(!azureDevOps.verify(req({ authorization: 'Bearer s3cret' }), raw, 's3cret'));
    assert.ok(!sameSecret('', 'x'));
  });

  test('a delivery names its event, its id for replays and its repository or project', () => {
    assert.deepEqual(gitlab.read(req({ 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'u-1' }), { project: { path_with_namespace: 'acme/shop' } }), { event: 'merge_request', delivery: 'u-1', scope: 'acme/shop' });
    assert.equal(gitlab.read(req({ 'x-gitlab-event': 'Confidential Issue Hook', 'x-gitlab-event-uuid': 'u-2' }), {})?.event, 'unhandled:Confidential Issue Hook', 'confidential issues are never linked');
    assert.equal(gitlab.read(req({ 'x-gitlab-event': 'Push Hook' }), {}), null, 'no delivery id');
    const ado = azureDevOps.read(req({}), {
      id: 'e-1', notificationId: 3, eventType: 'workitem.updated',
      resourceContainers: { account: { baseUrl: 'https://contoso.visualstudio.com/' } },
      resource: { workItemId: 5, revision: { fields: { 'System.TeamProject': 'Web Shop' } } },
    });
    assert.deepEqual(ado, { event: 'workitem.updated', delivery: '3:e-1', scope: 'contoso/Web Shop' });
    assert.equal(azureDevOps.read(req({}), { eventType: 'git.push', resource: {} }), null, 'no notification id');
    assert.ok(azureDevOps.inScope(['Contoso/web shop'], 'contoso/Web Shop'), 'organisation and project names are case-insensitive');
    assert.ok(!github.inScope(['acme/shop'], 'acme/shop2'));
  });

  test('pipeline states share one scale; refs need exactly six digits', () => {
    assert.deepEqual(['succeeded', 'failed', 'canceled', 'inProgress', 'notStarted', 'partiallySucceeded'].map(ciState), ['success', 'failure', 'cancelled', 'in_progress', 'queued', 'failure']);
    assert.deepEqual(refsIn('Fixes chg-000017 and AB#12, not INC0010001'), ['CHG000017']);
  });
});
