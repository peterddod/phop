import { type PeerMetadata, Room } from '@peterddod/phop';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ExposePhopApi } from './exposePhopApi';
import { GameProbe } from './gameProbe';

const params = new URLSearchParams(window.location.search);
const roomId = params.get('roomId') ?? 'default-room';
const serverUrl = params.get('serverUrl') ?? 'ws://localhost:8080';
const withGame = params.get('game') === '1';
const initialMetadata = params.has('meta')
  ? (JSON.parse(params.get('meta') as string) as PeerMetadata)
  : undefined;

declare global {
  interface Window {
    /** Replace this peer's `<Room metadata>`. */
    __setMetadata: (metadata: PeerMetadata | undefined) => void;
  }
}

function Harness() {
  const [metadata, setMetadata] = useState(initialMetadata);
  useEffect(() => {
    window.__setMetadata = setMetadata;
  }, []);
  return (
    <Room signallingServerUrl={serverUrl} roomId={roomId} metadata={metadata}>
      <ExposePhopApi />
      {withGame && <GameProbe />}
    </Room>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(<Harness />);
