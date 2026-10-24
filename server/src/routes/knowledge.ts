import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../security/auth.js';
import * as kb from '../reporting/knowledge.js';

type Ref = { Params: { ref: string } };

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get('/api/articles', async (req) => kb.listArticles(requireUser(req), kb.listArticlesSchema.parse(req.query)));
  app.post('/api/articles', async (req, reply) => {
    reply.code(201);
    return kb.createArticle(requireUser(req), kb.createArticleSchema.parse(req.body));
  });
  app.get<Ref>('/api/articles/:ref', async (req) => kb.getArticle(requireUser(req), req.params.ref));
  app.patch<Ref>('/api/articles/:ref', async (req) => kb.updateArticle(requireUser(req), req.params.ref, kb.updateArticleSchema.parse(req.body)));
  app.post<Ref>('/api/articles/:ref/transition', async (req) => kb.transitionArticle(requireUser(req), req.params.ref, kb.transitionArticleSchema.parse(req.body)));
  app.post<Ref>('/api/articles/:ref/comments', async (req) => kb.addArticleComment(requireUser(req), req.params.ref, z.object({ body: z.string().max(20_000) }).parse(req.body).body));
  app.post<Ref>('/api/articles/:ref/links', async (req) => kb.linkArticleCi(requireUser(req), req.params.ref, z.object({ ci: z.string().max(30) }).parse(req.body).ci, true));
  app.delete<{ Params: { ref: string; ci: string } }>('/api/articles/:ref/links/:ci', async (req) => kb.linkArticleCi(requireUser(req), req.params.ref, req.params.ci, false));
  app.post<Ref>('/api/articles/:ref/feedback', async (req) => kb.articleFeedback(requireUser(req), req.params.ref, z.object({ helpful: z.boolean() }).parse(req.body).helpful));
  app.get('/api/knowledge/suggest', async (req) => {
    const q = z.object({ text: z.string().max(2000).default(''), cis: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(20).default(5) }).parse(req.query);
    return kb.suggestArticles(requireUser(req), q.text, q.cis ? q.cis.split(',').map((c) => c.trim()).filter(Boolean) : [], q.limit);
  });
  app.post<Ref>('/api/problems/:ref/article', async (req, reply) => {
    reply.code(201);
    return kb.publishKnownError(requireUser(req), req.params.ref);
  });
  app.post<Ref>('/api/incidents/:ref/article', async (req, reply) => {
    reply.code(201);
    return kb.draftFromIncident(requireUser(req), req.params.ref);
  });
  app.post<Ref>('/api/incidents/:ref/articles-used', async (req) => {
    await kb.useArticleForIncident(requireUser(req), req.params.ref, z.object({ article: z.string().max(20) }).parse(req.body).article);
    return { ok: true };
  });
}
