/** /api/articles (+ /:ref): knowledge base articles. */
export interface ArticleRow {
  ref: string; title: string; article_type: ArticleType; audience: 'internal' | 'end_users'; status: 'draft' | 'published' | 'retired';
  owner: string | null; review_by: string | null; due_for_review: boolean; synced_with_problem: boolean; problem_ref: string | null;
  helpful: number; not_helpful: number; used_count: number; updated_at: string;
}
export type ArticleType = 'how_to' | 'troubleshooting' | 'known_error' | 'faq';
export interface Article extends ArticleRow {
  body: string; owner_id: number | null; problem_status: string | null; source_incident_ref: string | null; published_at: string | null;
  cis: { ref: string; name: string }[]; my_feedback: boolean | null; used_in: { ref: string; title: string; used_at: string }[];
  activity: { id: number; kind: string; body: string; created_at: string; user_name: string | null; data: any }[];
}
