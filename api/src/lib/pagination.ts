import { paginationSchema } from '../schemas.js';

export interface Pagination {
  limit: number;
  before?: string;
}

const DEFAULT_LIMIT = 50;

// Cursor pagination by a timestamp column: `?limit=` (capped, see paginationSchema) and
// `?before=<ISO timestamp>` (pass the last row's timestamp back to fetch the next page).
export function parsePagination(query: unknown): Pagination | { error: unknown } {
  const parsed = paginationSchema.safeParse(query);
  if (!parsed.success) return { error: parsed.error.flatten() };
  return { limit: parsed.data.limit ?? DEFAULT_LIMIT, before: parsed.data.before };
}
