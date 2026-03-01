import { Room } from '@peterddod/phop';
import { createRoot } from 'react-dom/client';
import { ExposePhopApi } from './exposePhopApi';

const params = new URLSearchParams(window.location.search);
const roomId = params.get('roomId') ?? 'default-room';
const serverUrl = params.get('serverUrl') ?? 'ws://localhost:8080';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <Room signallingServerUrl={serverUrl} roomId={roomId}>
    <ExposePhopApi />
  </Room>
);
