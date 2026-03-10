/**
 * In-memory notification subscription store.
 * Controls which events trigger MCP notifications (sendResourceListChanged).
 * No subscriptions = no notifications (silent by default).
 */

export interface Subscription {
  rooms?: string[];   // room IDs to watch (empty = don't filter by room)
  users?: string[];   // user IDs to watch (empty = don't filter by sender)
  dms?: boolean;      // watch all DMs
  all?: boolean;      // watch everything
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
}): boolean {
  if (!subscription) return false;
  if (subscription.all) return true;
  if (subscription.dms && event.isDM) return true;
  if (subscription.rooms?.length && subscription.rooms.includes(event.roomId)) return true;
  if (subscription.users?.length && subscription.users.includes(event.sender)) return true;
  return false;
}
