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
}
