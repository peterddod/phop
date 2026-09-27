import { useMemo, useRef } from 'react';
import { type Channel, type ChannelRoom, createChannel } from '../core/channel';
import { useRoom } from './useRoom';

/**
 * Typed, validated messaging on a named channel.
 *
 * The returned channel is stable for a given `name`; it always uses the
 * latest room and validator. Subscribe inside an effect:
 *
 * ```ts
 * const chat = useChannel('chat', isChatMessage);
 * useEffect(() => chat.subscribe((msg, from) => ...), [chat]);
 * ```
 */
export function useChannel<T>(name: string, validate: (data: unknown) => data is T): Channel<T> {
  const room = useRoom();
  const roomRef = useRef<ChannelRoom>(room);
  roomRef.current = room;
  const validateRef = useRef(validate);
  validateRef.current = validate;

  return useMemo(() => {
    const liveRoom: ChannelRoom = {
      get peerId() {
        return roomRef.current.peerId;
      },
      broadcast: (message) => roomRef.current.broadcast(message),
      sendToPeer: (peerId, message) => roomRef.current.sendToPeer(peerId, message),
      onMessage: (handler) => roomRef.current.onMessage(handler),
    };
    return createChannel(liveRoom, name, (data: unknown): data is T => validateRef.current(data));
  }, [name]);
}
