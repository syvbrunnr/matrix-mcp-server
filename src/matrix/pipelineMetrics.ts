/**
 * Event pipeline metrics — lightweight counters for diagnosing message flow.
 * Tracks events at each stage: received → filtered/enqueued/dropped.
 * Reset on server restart (intentional — these are diagnostic, not persistent).
 */

export interface PipelineMetrics {
  /** Total Timeline events received by the live listener */
  eventsReceived: number;
  /** Messages successfully enqueued */
  messagesEnqueued: number;
  /** Messages skipped by extractQueuedMessage (filtered) */
  messagesFiltered: number;
  /** Messages skipped by INSERT OR IGNORE (duplicate event_id) */
  messagesDeduplicated: number;
  /** Reactions enqueued */
  reactionsEnqueued: number;
  /** Edits processed */
  editsProcessed: number;
  /** Errors caught by try-catch in live listener */
  listenerErrors: number;
  /** Timestamp of first event */
  firstEventAt: number | null;
  /** Timestamp of most recent event */
  lastEventAt: number | null;
}

const metrics: PipelineMetrics = {
  eventsReceived: 0,
  messagesEnqueued: 0,
  messagesFiltered: 0,
  messagesDeduplicated: 0,
  reactionsEnqueued: 0,
  editsProcessed: 0,
  listenerErrors: 0,
  firstEventAt: null,
  lastEventAt: null,
};

export function increment(key: keyof Omit<PipelineMetrics, "firstEventAt" | "lastEventAt">): void {
  metrics[key]++;
  const now = Date.now();
  if (!metrics.firstEventAt) metrics.firstEventAt = now;
  metrics.lastEventAt = now;
}

export function getMetrics(): PipelineMetrics {
  return { ...metrics };
}
