/**
 * Utility functions for consistent timestamp handling throughout the application
 */

/**
 * Formats a date for database storage
 * @param date - The date to format (defaults to current date)
 * @returns ISO 8601 formatted string
 */
export function formatForDatabase(date: Date = new Date()): string {
  return date.toISOString();
}

function toDate(timestamp: string | Date): Date {
  return timestamp instanceof Date ? timestamp : new Date(timestamp);
}

/**
 * Formats a timestamp for display to users
 * @param timestamp - The timestamp string from database or Date object
 * @returns Localized time string
 */
export function formatForDisplay(timestamp: string | Date): string {
  const date = toDate(timestamp);
  return date.toLocaleTimeString();
}

/**
 * Formats a timestamp with full date and time for display
 * @param timestamp - The timestamp string from database or Date object
 * @returns Localized date and time string
 */
function formatFullDateTime(timestamp: string | Date): string {
  const date = toDate(timestamp);
  return date.toLocaleString();
}

/**
 * Gets the current timestamp in ISO format for database storage
 * @returns ISO 8601 formatted string
 */
function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Checks if a timestamp is valid
 * @param timestamp - The timestamp to validate
 * @returns boolean indicating if the timestamp is valid
 */
export function isValidTimestamp(timestamp: string | Date | null | undefined): boolean {
  if (!timestamp) return false;
  const date = toDate(timestamp);
  return !isNaN(date.getTime());
}

/**
 * Converts a timestamp to UTC
 * @param timestamp - The timestamp to convert
 * @returns UTC ISO string
 */
function toUTC(timestamp: string | Date): string {
  const date = toDate(timestamp);
  return date.toISOString();
}

/**
 * Gets the time difference between two timestamps
 * @param start - Start timestamp
 * @param end - End timestamp (defaults to current time)
 * @returns Duration in milliseconds
 */
export function getTimeDifference(start: string | Date, end: string | Date = new Date()): number {
  const startDate = toDate(start);
  const endDate = toDate(end);
  return endDate.getTime() - startDate.getTime();
}

/**
 * Formats a duration in milliseconds to a human-readable string
 * @param ms - Duration in milliseconds
 * @returns Human-readable duration string
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
