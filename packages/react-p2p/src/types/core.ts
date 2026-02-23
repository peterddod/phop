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
