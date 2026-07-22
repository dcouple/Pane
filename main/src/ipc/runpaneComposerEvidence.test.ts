import { describe, expect, it } from 'vitest';
import { assessComposerEvidence, isSlashCommandInput } from './runpaneComposerEvidence';

const stagedText = '/do TM-x';

describe('isSlashCommandInput', () => {
  it.each([
    ['/do TM-x', true],
    ['  /frobnicate x', true],
    ['\n/status\nmore', true],
    ['/', false],
    ['$discussion issue', false],
    ['ordinary prose', false],
  ])('classifies %j as %s', (input, expected) => {
    expect(isSlashCommandInput(input)).toBe(expected);
  });
});

describe('assessComposerEvidence', () => {
  const cases: Array<{
    name: string;
    beforeText: string;
    afterText: string;
    expected: ReturnType<typeof assessComposerEvidence>;
  }> = [
    {
      name: 'Codex staged input with autocomplete popup',
      beforeText: '› /do TM-x\n  /do  Run implementation workflow',
      afterText: '› /do TM-x\n  /do  Run implementation workflow',
      expected: 'staged',
    },
    {
      name: 'Codex staged input after popup closes',
      beforeText: '› /do TM-x\n  /do  Run implementation workflow',
      afterText: '› /do TM-x',
      expected: 'staged',
    },
    {
      name: 'Claude staged input row',
      beforeText: '❯ /do TM-x\n  ctrl+enter to submit',
      afterText: '❯ /do TM-x\n  ctrl+enter to submit',
      expected: 'staged',
    },
    {
      name: 'submitted input echoed in transcript with spinner',
      beforeText: '› /do TM-x',
      afterText: '› /do TM-x\nWorking (2s)\n›',
      expected: 'unknown',
    },
    {
      name: 'submitted input echoed in idle transcript',
      beforeText: '❯ /do TM-x',
      afterText: 'Human: /do TM-x\nAssistant: Done.\n❯',
      expected: 'unknown',
    },
    {
      name: 'composer cleared with no echo',
      beforeText: '› /do TM-x',
      afterText: 'Working (1s)\n›',
      expected: 'cleared',
    },
    {
      name: 'empty screen',
      beforeText: '› /do TM-x',
      afterText: '',
      expected: 'cleared',
    },
    {
      name: 'marker moved between prompt styles',
      beforeText: '› /do TM-x',
      afterText: '❯ /do TM-x',
      expected: 'unknown',
    },
  ];

  it.each(cases)('$name -> $expected', ({ beforeText, afterText, expected }) => {
    expect(assessComposerEvidence({ beforeText, afterText, stagedText })).toBe(expected);
  });

  it('returns unknown when staged text has no usable marker', () => {
    expect(assessComposerEvidence({
      beforeText: '›',
      afterText: '›',
      stagedText: ' \n ',
    })).toBe('unknown');
  });
});
