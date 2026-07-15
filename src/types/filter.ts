/**
 * Filter-related type definitions for the Isagi Engine Signal Bot.
 * Defines macro filter status and result structures.
 */

/** Current status of all macro filters */
export interface FilterStatus {
  timeGate: { active: boolean; windowStart: string; windowEnd: string };
  newsDecoupler: {
    freezeActive: boolean;
    currentEvent: string | null;
    freezeEnd: string | null;
  };
  circuitBreaker: { active: boolean; expiresAt: string | null };
}

/** Result of checking all filters for a signal */
export interface FilterResult {
  passed: boolean;
  blockedBy: string | null;
  reason: string | null;
}
