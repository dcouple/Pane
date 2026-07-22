export type ComposerEvidenceVerdict = 'staged' | 'cleared' | 'unknown';

const COMPOSER_PROMPT_PATTERN = /^[>›❯▌]/u;
const COMPOSER_AUXILIARY_PATTERN = /^(?:\/\S|\[Pasted Content|(?:press\s+)?(?:ctrl|control)\+enter\s+to\s+submit)/iu;
const MAX_MARKER_LENGTH = 80;

export function isSlashCommandInput(input: string): boolean {
  return /^\/\S/u.test(input.trimStart());
}

export function assessComposerEvidence(args: {
  beforeText: string;
  afterText: string;
  stagedText: string;
}): ComposerEvidenceVerdict {
  const marker = firstNonEmptyLine(args.stagedText)?.slice(0, MAX_MARKER_LENGTH);
  if (!marker) {
    return 'unknown';
  }

  if (!args.afterText.includes(marker)) {
    return 'cleared';
  }

  const beforeComposerLine = lastComposerLine(args.beforeText, marker);
  const afterComposerLine = lastComposerLine(args.afterText, marker);
  if (
    beforeComposerLine !== undefined &&
    afterComposerLine !== undefined &&
    beforeComposerLine === afterComposerLine
  ) {
    return 'staged';
  }

  return 'unknown';
}

function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => line.length > 0);
}

function lastComposerLine(text: string, marker: string): string | undefined {
  const lines = text.split(/\r?\n/u).map(line => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes(marker)) {
      continue;
    }

    const followingLines = lines.slice(index + 1).filter(candidate => candidate.length > 0);
    const couldBeTranscript = followingLines.some(candidate => !COMPOSER_AUXILIARY_PATTERN.test(candidate));
    if (couldBeTranscript) {
      return undefined;
    }

    if (COMPOSER_PROMPT_PATTERN.test(line) || (line === marker && followingLines.length === 0)) {
      return line;
    }
  }
  return undefined;
}
