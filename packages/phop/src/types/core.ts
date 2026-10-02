export type JSONSerializable =
  | string
  | number
  | boolean
  | null
  | undefined
  | JSONSerializable[]
  | { [key: string]: JSONSerializable };

export type Message<TData extends JSONSerializable = JSONSerializable> = {
  /** The peer ID of the sender */
  senderId: string;
  /** The data of the message */
  data: TData;
  /** The timestamp of when the message was sent */
  timestamp: number;
};

export type MessageHandler<TData extends JSONSerializable = JSONSerializable> = (
  message: Message<TData>
) => void;

export interface SendOptions {
  /**
   * Coalescing key. While a peer's channel is congested, a message with a key
   * is held back and replaced by any newer message with the same key, so only
   * the latest one is sent once the channel drains. Use it for messages that
   * supersede each other, like state snapshots.
   */
  coalesce?: string;
  /**
   * With `coalesce`: the serialised message (a JSON `Message`) to send in
   * its place when it replaces a held message, which the peer then never
   * gets. For messages that build on the one before (e.g. a delta), so the
   * peer gets a self-contained one instead. Called at most once per peer.
   */
  supersede?: () => string;
}
