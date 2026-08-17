import { loadReactScan } from '../devtools/loadReactScan';

async function bootstrapRemote(): Promise<void> {
  await loadReactScan();
  const { mountRemoteRenderer } = await import('./bootstrap');
  mountRemoteRenderer();
}

bootstrapRemote().catch(error => {
  console.error('Failed to bootstrap the Pane remote renderer.', error);
});
