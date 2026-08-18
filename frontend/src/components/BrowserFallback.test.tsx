import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrowserFallback } from './BrowserFallback';

describe('BrowserFallback', () => {
  it('keeps the Remote Pane entry relative to the packaged frontend directory', () => {
    const markup = renderToStaticMarkup(<BrowserFallback />);

    expect(markup).toContain('href="./remote.html"');
    expect(markup).not.toContain('href="/remote.html"');
  });
});
