import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './contexts/ThemeContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';
import './styles/markdown-preview.css';
import './styles/notebook-preview.css';

let mounted = false;

interface RendererErrorDetails {
  toString(): string;
}

type RendererErrorValue = Error | string | RendererErrorDetails | null | undefined;

function getErrorMessage(value: RendererErrorValue): string {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) || String(value);
  } catch {
    return String(value);
  }
}

function getErrorStack(value: RendererErrorValue): string | undefined {
  return value instanceof Error ? value.stack : undefined;
}

function reportRendererFatal(payload: {
  kind: 'unhandledrejection' | 'error';
  message: string;
  stack?: string;
  url?: string;
  line?: number;
  column?: number;
}) {
  window.electronAPI?.diagnostics?.rendererFatal(payload).catch(() => {});
}

function BrowserFallback() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-primary p-6 text-text-primary">
      <section className="w-full max-w-lg rounded-lg border border-border-primary bg-surface-primary p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Pane Desktop</p>
        <h1 className="mt-3 text-2xl font-semibold">Open Pane from the desktop app</h1>
        <p className="mt-3 text-sm leading-6 text-text-secondary">
          This entry needs Electron APIs. To test the browser client, open Remote Pane instead.
        </p>
        <a
          className="mt-6 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover"
          href="/remote.html"
        >
          Open Remote Pane
        </a>
      </section>
    </main>
  );
}

export function mountDesktopRenderer(): void {
  if (mounted) return;
  mounted = true;

  // Global error handlers catch failures outside React error boundaries.
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    reportRendererFatal({
      kind: 'unhandledrejection',
      message: getErrorMessage(event.reason),
      stack: getErrorStack(event.reason),
      url: window.location.href,
    });
    event.preventDefault();
    alert('An unexpected error occurred. The application may need to be restarted.\n\nError: ' + (event.reason?.message || String(event.reason)));
  });

  window.addEventListener('error', (event) => {
    console.error('Uncaught error:', event.error);
    reportRendererFatal({
      kind: 'error',
      message: getErrorMessage(event.error || event.message),
      stack: getErrorStack(event.error),
      url: event.filename || window.location.href,
      line: event.lineno,
      column: event.colno,
    });
  });

  // Prevent Chromium from navigating away when files are dropped outside a registered drop zone.
  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });

  const root = ReactDOM.createRoot(document.getElementById('root')!);
  if (!window.electronAPI) {
    root.render(
      <React.StrictMode>
        <BrowserFallback />
      </React.StrictMode>,
    );
    return;
  }

  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
