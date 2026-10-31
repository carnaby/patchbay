import { z } from 'zod';

/** Lowercase words joined by single hyphens: the folder name under showcase/ and the public URL slug. */
export const USE_CASE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const UseCaseMetaSchema = z.strictObject({
  id: z.string().max(40).regex(USE_CASE_SLUG),
  order: z.number().int().min(0).max(1000),
  title: z.string().min(1).max(60),
  tab: z.string().min(1).max(24),
  description: z.string().min(1).max(200),
});
export type UseCaseMeta = z.infer<typeof UseCaseMetaSchema>;

/**
 * Owner of the showcase dashboards. User ids are generated with a `u_` prefix, so no account can ever own them, and
 * canEdit compares owner ids, which makes them read-only for everyone.
 */
export const SHOWCASE_OWNER_ID = 'system';

/** Dashboard ids are [a-z0-9]{6,32}; the prefix keeps showcase ids recognisable next to random ones. */
export function useCaseDashboardId(slug: string): string {
  return `sc${slug.replace(/-/g, '')}`.slice(0, 32);
}

/** One use case as the landing page receives it. */
export interface UseCaseInfo {
  id: string;
  title: string;
  tab: string;
  description: string;
  prompt: string;
  dashboardId: string;
  /** URL with a content-hash cache key, or null when the use case has no video yet. */
  video: string | null;
  poster: string | null;
}
