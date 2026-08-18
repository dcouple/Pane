export function BrowserFallback() {
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
          href="./remote.html"
        >
          Open Remote Pane
        </a>
      </section>
    </main>
  );
}
