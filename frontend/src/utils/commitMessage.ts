export interface CommitMessageParts {
  title: string;
  description: string;
}

export function splitCommitMessage(message: string): CommitMessageParts {
  const [title = '', ...descriptionLines] = message.replace(/\r\n?/g, '\n').split('\n');

  while (descriptionLines[0]?.trim() === '') {
    descriptionLines.shift();
  }

  return {
    title: title.trim(),
    description: descriptionLines.join('\n').trim(),
  };
}

export function composeCommitMessage(title: string, description: string): string {
  const normalizedTitle = title.trim();
  const normalizedDescription = description.trim();

  return normalizedDescription
    ? `${normalizedTitle}\n\n${normalizedDescription}`
    : normalizedTitle;
}
