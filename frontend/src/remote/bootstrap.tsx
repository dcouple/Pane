import React from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import '@xterm/xterm/css/xterm.css';
import { RemotePwaApp } from './RemotePwaApp';

let mounted = false;

export function mountRemoteRenderer(): void {
  if (mounted) return;
  mounted = true;

  document.documentElement.classList.add('light-rounded');
  document.body.classList.add('light-rounded');

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <RemotePwaApp />
    </React.StrictMode>,
  );
}
