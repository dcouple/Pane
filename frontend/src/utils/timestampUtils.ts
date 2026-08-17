/**
 * Utility functions for consistent timestamp handling in the frontend
 */

/**
 * Formats a timestamp for display to users
 * @param timestamp - The timestamp string from database or Date object
 * @returns Localized time string
 */
/**
 * Formats a timestamp with full date and time for display
 * @param timestamp - The timestamp string from database or Date object
 * @returns Localized date and time string
 */
/**
 * Formats the distance between a timestamp and now
 * @param date - The date to compare
 * @returns Human-readable time distance
 */
export function formatDistanceToNow(date: Date | string): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - dateObj.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  } else if (diffHours > 0) {
    return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  } else if (diffMinutes > 0) {
    return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
  } else {
    return 'just now';
  }
}

/**
 * Checks if a timestamp is valid
 * @param timestamp - The timestamp to validate
 * @returns boolean indicating if the timestamp is valid
 */
export function isValidTimestamp(timestamp: string | Date | null | undefined): boolean {
  if (!timestamp) return false;
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return !isNaN(date.getTime());
}

/**
 * Gets the time difference between two timestamps
 * @param start - Start timestamp
 * @param end - End timestamp (defaults to current time)
 * @returns Duration in milliseconds
 */
/**
 * Formats a duration in milliseconds to a human-readable string
 * @param ms - Duration in milliseconds
 * @returns Human-readable duration string
 */
/**
 * Formats a timestamp for sorting/comparison
 * @param timestamp - The timestamp to format
 * @returns ISO string for consistent sorting
 */
