export async function loadReactScan(): Promise<void> {
  if (!__PANE_REACT_SCAN_ENABLED__) return;

  try {
    const { initializeReactScan } = await import('./reactScan');
    initializeReactScan();
  } catch (error) {
    console.warn('[render-evidence] React Scan could not be loaded.', error);
  }
}
