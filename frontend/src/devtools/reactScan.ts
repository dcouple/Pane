import { scan } from 'react-scan';

interface RenderSummary {
  renders: number;
  timeMs: number;
}

const summaries = new Map<string, RenderSummary>();
let initialized = false;

function flushRenderEvidence(): void {
  try {
    if (summaries.size === 0) return;

    const components = [...summaries.entries()]
      .sort(([, left], [, right]) => right.renders - left.renders || right.timeMs - left.timeMs)
      .slice(0, 20)
      .map(([component, summary]) => ({
        component,
        renders: summary.renders,
        timeMs: Number(summary.timeMs.toFixed(2))
      }));

    summaries.clear();
    console.info(`[render-evidence] ${JSON.stringify({
      surface: window.location.pathname.endsWith('remote.html') ? 'remote-pwa' : 'desktop',
      intervalMs: 1000,
      components
    })}`);
  } catch (error) {
    summaries.clear();
    console.warn('[render-evidence] React Scan aggregation failed.', error);
  }
}

export function initializeReactScan(): void {
  if (initialized) return;
  initialized = true;

  try {
    scan({
      enabled: true,
      showToolbar: true,
      log: false,
      onRender(_fiber, renders) {
        try {
          const componentName = renders[0]?.componentName ?? 'Anonymous';
          const summary = summaries.get(componentName) ?? { renders: 0, timeMs: 0 };

          for (const render of renders) {
            summary.renders += render.count;
            summary.timeMs += render.time ?? 0;
          }
          summaries.set(componentName, summary);
        } catch (error) {
          console.warn('[render-evidence] React Scan render callback failed.', error);
        }
      }
    });
    window.setInterval(flushRenderEvidence, 1000);
  } catch (error) {
    initialized = false;
    console.warn('[render-evidence] React Scan initialization failed.', error);
  }
}
