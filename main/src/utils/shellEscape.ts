/**
 * Safely escape shell arguments to prevent command injection
 */

/**
 * Escape a string for safe use in shell commands
 * @param arg The argument to escape
 * @returns The escaped argument
 */
export function escapeShellArg(arg: string): string {
  // If the argument is empty, return empty quotes
  if (!arg) return "''";
  
  // For Windows, wrap in double quotes and escape internal quotes
  if (process.platform === 'win32') {
    // Escape existing double quotes and backslashes
    const escaped = arg
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  
  // For Unix-like systems, use single quotes and handle internal single quotes
  // by ending the quote, adding an escaped single quote, and starting a new quote
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Build a safe git commit command with proper escaping
 * @param message The commit message
 * @param enableCommitFooter If true (default), add the Pane footer
 * @returns The safe commit command
 */
export function buildGitCommitCommand(message: string, enableCommitFooter: boolean = true): string {
  // Create the full commit message with signature
  const fullMessage = enableCommitFooter ? `${message}

Co-Authored-By: Pane <runpane@users.noreply.github.com>` : message;
  
  // For Windows, use a different approach
  if (process.platform === 'win32') {
    // Write to a temporary file or use -F - with stdin
    // For now, escape for direct use
    const escaped = fullMessage
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
    return `git commit -m "${escaped}"`;
  }
  
  // For Unix-like systems, use proper shell escaping
  const escapedMessage = escapeShellArg(fullMessage);
  return `git commit -m ${escapedMessage}`;
}
