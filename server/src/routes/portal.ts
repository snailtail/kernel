import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as portal from '../requests/portal.js';
import { startSso } from '../security/sso.js';

type RefParams = { Params: { ref: string } };

/**
 * The self-service portal (#45): its page (/portal) and its own API (/api/portal/*). Kernel's session never reaches
 * here (app.ts skips authentication for /api/portal/), and the portal's session is read nowhere else. With the
 * module off, neither exists.
 */
export async function portalRoutes(app: FastifyInstance) {
  // The page is the web app's; it is only served while the portal is on.
  const page = async (_req: FastifyRequest, reply: FastifyReply) => {
    portal.assertPortalOn();
    reply.header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
    if (typeof (reply as any).sendFile === 'function') return (reply as any).sendFile('index.html');
    return reply.type('text/plain; charset=utf-8').send('The portal is served by the web build.');
  };
  app.get('/portal', page);
  app.get('/portal/*', page);

  await app.register(async (scope) => {
    scope.addHook('onRequest', async () => portal.assertPortalOn());
    // Signed-in routes run as the person (audit trail, activity), bound to their own records.
    const signedIn = <T>(fn: (person: portal.PortalPerson, req: FastifyRequest) => Promise<T>) => async (req: FastifyRequest) => {
      const person = await portal.requirePerson(req);
      return portal.asPortal(person, () => fn(person, req));
    };

    scope.get('/api/portal/auth/options', async () => portal.signInOptions());
    scope.post('/api/portal/auth/link', async (req) => portal.requestLink(req, portal.linkRequestSchema.parse(req.body)));
    scope.post('/api/portal/auth/signin', async (req, reply) => portal.signInWithLink(req, reply, portal.linkSignInSchema.parse(req.body).token));
    scope.get('/api/portal/auth/sso', async (req, reply) => startSso(req, reply, 'portal'));
    scope.post('/api/portal/auth/logout', async (req, reply) => {
      await portal.requirePerson(req).catch(() => null);
      return portal.endPortalSession(req, reply);
    });

    scope.get('/api/portal/me', signedIn(async (person) => portal.me(person)));
    scope.get('/api/portal/tickets', signedIn(async (person) => portal.myTickets(person)));
    scope.get<RefParams>('/api/portal/tickets/:ref', signedIn(async (person, req) => portal.ticket(person, (req.params as { ref: string }).ref)));
    scope.post<RefParams>('/api/portal/tickets/:ref/messages', signedIn(async (person, req) =>
      portal.addInformation(person, (req.params as { ref: string }).ref, portal.messageSchema.parse(req.body).body)));
    scope.post<RefParams>('/api/portal/tickets/:ref/confirm', signedIn(async (person, req) =>
      portal.confirm(person, (req.params as { ref: string }).ref, portal.confirmSchema.parse(req.body))));
    scope.get('/api/portal/services', signedIn(async (person) => portal.services(person)));
    scope.get('/api/portal/suggestions', signedIn(async (_person, req) => portal.suggest(String((req.query as { q?: string }).q ?? '').slice(0, 500))));
    scope.get<RefParams>('/api/portal/articles/:ref', signedIn(async (_person, req) => portal.article((req.params as { ref: string }).ref)));
    scope.post('/api/portal/problems', signedIn(async (person, req) => portal.reportProblem(person, portal.reportSchema.parse(req.body))));
    // Part 2: asking for something, service status, and how it went.
    scope.get('/api/portal/catalogue', signedIn(async () => portal.catalogue()));
    scope.get('/api/portal/catalogue/:id', signedIn(async (_person, req) => portal.catalogueItem(Number((req.params as { id: string }).id))));
    scope.post('/api/portal/requests', signedIn(async (person, req) => portal.order(person, portal.orderSchema.parse(req.body))));
    scope.get('/api/portal/status', signedIn(async (person) => portal.serviceStatus(person)));
    scope.post('/api/portal/status/subscribe', signedIn(async (person, req) => portal.subscribe(person, req.ip)));
    scope.post<RefParams>('/api/portal/tickets/:ref/rating', signedIn(async (person, req) =>
      portal.rate(person, (req.params as { ref: string }).ref, portal.rateSchema.parse(req.body))));
  });
}
