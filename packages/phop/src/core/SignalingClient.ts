import type { SignalData } from './PeerConnection';

type SignalingEventHandler = (event: SignalingEvent) => void;

interface SignalingEvent {
  type: 'joined' | 'peer-list' | 'peer-joined' | 'peer-left' | 'signal' | 'disconnected';
  peerId?: string;
  peers?: string[];
  from?: string;
  data?: SignalData;
}

class SignalingClient {
  private ws: WebSocket | null = null;
  private eventHandlers: Map<string, SignalingEventHandler[]> = new Map();
  private peerId: string = '';

  constructor(
    private serverUrl: string,
    private roomId: string
  ) {}

  connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.serverUrl);

      this.ws.onopen = () => {
        this.send({
          type: 'join',
          roomId: this.roomId,
        });
      };

      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);

        if (message.type === 'joined') {
          this.peerId = message.peerId;
          resolve(message.peerId);
        }

        this.emit(message);
      };

      this.ws.onerror = (error) => {
        reject(error);
      };

      this.ws.onclose = () => {
        console.log('Disconnected from signaling server');
      };
    });
  }

  send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  on(eventType: string, handler: SignalingEventHandler): void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    this.eventHandlers.get(eventType)?.push(handler);
  }

  off(eventType: string, handler: SignalingEventHandler): void {
    const handlers = this.eventHandlers.get(eventType);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  private emit(event: SignalingEvent): void {
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      handlers.forEach((handler) => {
        handler(event);
      });
    }

    const wildcardHandlers = this.eventHandlers.get('*');
    if (wildcardHandlers) {
      wildcardHandlers.forEach((handler) => {
        handler(event);
      });
    }
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  getPeerId(): string {
    return this.peerId;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export { SignalingClient };
