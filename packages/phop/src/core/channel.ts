import type { JSONSerializable, Message, MessageHandler, SendOptions } from '../types';

/** The room surface a channel needs. `RoomContextValue` satisfies it. */
export interface ChannelRoom {
  peerId: string;
  broadcast: <TData extends JSONSerializable = JSONSerializable>(
    message: Message<TData>,
    options?: SendOptions
  ) => void;
  sendToPeer: <TData extends JSONSerializable = JSONSerializable>(
    peerId: string,
    message: Message<TData>,
    options?: SendOptions
  ) => void;
  onMessage: <TData extends JSONSerializable = JSONSerializable>(
    handler: MessageHandler<TData>
  ) => () => void;
  /**
   * `broadcast` for a message already serialised (a JSON `Message`). Rooms
   * without it get the message parsed and passed to `broadcast`.
   */
  broadcastText?: (text: string, options?: SendOptions) => void;
}

/**
 * A named, typed message stream over a room. Incoming data is untrusted, so
 * every message is checked with the channel's validator and dropped if it
 * fails. The sender id comes from the transport, never from the payload.
 */
export interface Channel<T> {
  /**
   * On a `latestOnly` channel, `supersede` is sent in place of `data` to a
   * peer for whom `data` replaces a held message (see `SendOptions.supersede`).
   */
  send(peerId: string, data: T, supersede?: T): void;
  broadcast(data: T, supersede?: T): void;
  /**
   * Broadcast a message serialised by `channelMessageText` for this channel,
   * e.g. in a Web Worker, so the sender skips `JSON.stringify`.
   */
  broadcastText(text: string, supersede?: T): void;
  subscribe(handler: (data: T, senderId: string) => void): () => void;
}

interface ChannelEnvelope {
  ch: string;
  d: JSONSerializable;
}

export interface ChannelOptions {
  /**
   * Each message supersedes the previous one (e.g. state snapshots): while a
   * peer's channel is congested only the newest is kept and sent once it
   * drains. See `SendOptions.coalesce`.
   */
  latestOnly?: boolean;
}

function isEnvelope(value: unknown): value is ChannelEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ch?: unknown }).ch === 'string' &&
    'd' in value
  );
}

/**
 * A channel message as the JSON text a room sends, from its payload's JSON
 * text. What `Channel.broadcastText` takes.
 */
export function channelMessageText(
  senderId: string,
  name: string,
  dataText: string,
  timestamp = Date.now()
): string {
  return `{"senderId":${JSON.stringify(senderId)},"data":{"ch":${JSON.stringify(name)},"d":${dataText}},"timestamp":${timestamp}}`;
}

/**
 * Create a channel. `room` is read on every call, so an object whose fields
 * change over time (e.g. with getters) always uses the latest values.
 *
 * Payloads must survive a JSON round trip; `T` is unconstrained so interfaces
 * can be used without casts.
 */
export function createChannel<T>(
  room: ChannelRoom,
  name: string,
  validate: (data: unknown) => data is T,
  options: ChannelOptions = {}
): Channel<T> {
  const wrap = (data: T): Message<JSONSerializable> => ({
    senderId: room.peerId,
    data: { ch: name, d: data as JSONSerializable },
    timestamp: Date.now(),
  });
  const sendOptions = (supersede?: T): SendOptions | undefined => {
    if (!options.latestOnly) return undefined;
    if (supersede === undefined) return { coalesce: name };
    // Serialised once, and only if some peer needs it.
    let text: string | undefined;
    return {
      coalesce: name,
      supersede: () => {
        if (text === undefined) text = JSON.stringify(wrap(supersede));
        return text;
      },
    };
  };

  return {
    send: (peerId, data, supersede) => {
      room.sendToPeer(peerId, wrap(data), sendOptions(supersede));
    },
    broadcast: (data, supersede) => {
      room.broadcast(wrap(data), sendOptions(supersede));
    },
    broadcastText: (text, supersede) => {
      if (room.broadcastText) room.broadcastText(text, sendOptions(supersede));
      else room.broadcast(JSON.parse(text) as Message<JSONSerializable>, sendOptions(supersede));
    },
    subscribe: (handler) =>
      room.onMessage(({ senderId, data }) => {
        if (!isEnvelope(data) || data.ch !== name) return;
        if (!validate(data.d)) return;
        handler(data.d, senderId);
      }),
  };
}
