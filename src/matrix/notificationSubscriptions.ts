/**
 * In-memory notification subscription store.
 * Controls which events trigger MCP notifications (sendResourceListChanged).
 * No subscriptions = no notifications (silent by default).
 */

export interface Subscription {
  rooms?: string[];        // room IDs to watch (empty = don't filter by room)
  users?: string[];        // user IDs to watch (empty = don't filter by sender)
  dms?: boolean;           // watch all DMs
  all?: boolean;           // watch everything
  mentionsOnly?: boolean;  // additionally subscribe to @mentions in any joined room
}

let subscription: Subscription | null = null;

/** Set the active subscription. Pass null to unsubscribe. */
export function setSubscription(sub: Subscription | null): void {
  subscription = sub;
}

/** Get the current subscription (null if none). */
export function getSubscription(): Subscription | null {
  return subscription;
}

/** Check if an event matches the active subscription. */
export function matchesSubscription(event: {
  roomId: string;
  sender: string;
  isDM: boolean;
  body?: string;
}): boolean {
  if (!subscription) return false;
  if (subscription.all) return true;
  if (subscription.dms && event.isDM) return true;
  if (subscription.rooms?.length && subscription.rooms.includes(event.roomId)) return true;
  if (subscription.users?.length && subscription.users.includes(event.sender)) return true;
  if (subscription.mentionsOnly && event.body && isMention(event.body)) return true;
  return false;
}

/** Check if a message body mentions the bot's Matrix user ID or localpart. */
function isMention(body: string): boolean {
  const userId = process.env.MATRIX_USER_ID;
  if (!userId) return false;
  const lower = body.toLowerCase();
  // Check full user ID (@mimir:domain.com)
  if (lower.includes(userId.toLowerCase())) return true;
  // Check localpart (mimir) — extract from @localpart:domain
  const match = userId.match(/^@([^:]+):/);
  if (match) {
    const localpart = match[1].toLowerCase();
    // Only match as a word boundary to avoid false positives (e.g. "optimizer")
    const pattern = new RegExp(`\\b${localpart}\\b`, "i");
    if (pattern.test(body)) return true;
  }
  return false;
}
