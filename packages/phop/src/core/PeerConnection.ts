import type { SendOptions } from '../types';
import type { PeerLink, PeerLinkOptions, SignalingSession } from './transport';
import { createInbox, DEFAULT_MAX_BUFFERED_AMOUNT, maxMessageSizeOf, Outbox } from './wire';

export type SignalData =
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit };

export type PeerConnectionOptions = PeerLinkOptions;

class PeerConnection implements PeerLink {
  private static readonly DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;
  private outbox: Outbox | null = null;
  private selfPeerId: string;
  private remotePeerId: string;
  private signalingClient: SignalingSession;
  private maxBufferedAmount: number;
  private onChannelMessage?: (peerId: string, message: Record<string, unknown>) => void;
  private onChannelOpen?: (remotePeerId: string) => void;
  private onChannelClose?: (remotePeerId: string) => void;

  constructor(opts: PeerConnectionOptions) {
    this.selfPeerId = opts.localPeerId;
    this.remotePeerId = opts.remotePeerId;
    this.signalingClient = opts.signalingClient;
    this.onChannelMessage = opts.onChannelMessage;
    this.onChannelOpen = opts.onChannelOpen;
    this.onChannelClose = opts.onChannelClose;
    this.maxBufferedAmount = opts.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT;

    this.pc = new RTCPeerConnection(
      opts.rtcConfig ?? { iceServers: PeerConnection.DEFAULT_ICE_SERVERS }
    );

    this.setupConnection();

    if (this.initiator) {
      this.initiate();
    }
  }

  get initiator(): boolean {
    return this.selfPeerId > this.remotePeerId;
  }

  private setupConnection() {
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingClient.send({
          type: 'signal',
          to: this.remotePeerId,
          data: {
            type: 'ice-candidate',
            candidate: event.candidate,
          },
        });
      }
    };

    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupDataChannel(event.channel);
    };
  }

  private async initiate() {
    this.dataChannel = this.pc.createDataChannel('game-sync');
    this.setupDataChannel(this.dataChannel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    this.signalingClient.send({
      type: 'signal',
      to: this.remotePeerId,
      data: {
        type: 'offer',
        sdp: offer,
      },
    });
  }

  async handleSignal(data: SignalData) {
    switch (data.type) {
      case 'offer': {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);

        this.signalingClient.send({
          type: 'signal',
          to: this.remotePeerId,
          data: {
            type: 'answer',
            sdp: answer,
          },
        });
        break;
      }

      case 'answer':
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        break;

      case 'ice-candidate':
        await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        break;
    }
  }

  private setupDataChannel(channel: RTCDataChannel) {
    this.outbox = new Outbox(channel, this.maxBufferedAmount, () =>
      maxMessageSizeOf(this.pc.sctp?.maxMessageSize)
    );
    const receive = createInbox((message) => this.onChannelMessage?.(this.remotePeerId, message));

    channel.onopen = () => {
      console.log(`Data channel open to ${this.remotePeerId}`);
      this.onChannelOpen?.(this.remotePeerId);
    };

    channel.onclose = () => {
      console.log(`Data channel closed to ${this.remotePeerId}`);
      this.onChannelClose?.(this.remotePeerId);
    };

    channel.onerror = (error) => {
      console.error(`Data channel error with ${this.remotePeerId}:`, error);
    };

    channel.onmessage = (event) => receive(event.data);
  }

  /** Send a serialised message, split to fit the channel's maximum message size. */
  send(text: string, options?: SendOptions) {
    if (this.dataChannel?.readyState === 'open') {
      this.outbox?.send(text, options);
    }
  }

  close() {
    this.dataChannel?.close();
    this.pc.close();
  }
}

export { PeerConnection };
