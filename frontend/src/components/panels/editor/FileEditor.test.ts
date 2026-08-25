import { describe, expect, it } from 'vitest';
import { isHtmlFile } from './htmlFile';

describe('isHtmlFile', () => {
  it.each(['index.html', 'archive/page.htm', 'REPORT.HTML', 'page.HTM'])(
    'recognizes %s as HTML',
    (filePath) => expect(isHtmlFile(filePath)).toBe(true),
  );

  it.each(['index.ts', 'html', 'page.html.txt', 'page.xhtml'])(
    'does not recognize %s as HTML',
    (filePath) => expect(isHtmlFile(filePath)).toBe(false),
  );
});
