import { VenueError } from './hedgeVenue.js';

export function mapKrakenError(envelope: { error?: { category?: string; message?: string; retryable?: boolean; retry_after_ms?: number } }, fallback: string): VenueError | null {
  const e = envelope.error;
  if (!e) return null;
  const cat = e.category;
  const allowed = ['auth','rate_limit','network','validation','api','parse'] as const;
  const category = (allowed as readonly string[]).includes(cat ?? '') ? (cat as typeof allowed[number]) : 'api';
  return new VenueError(category, e.message ?? fallback, e.retryable ?? false, e.retry_after_ms);
}
