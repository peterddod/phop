import type { JSONSerializable } from '../../context/Room';

export type MergeMeta = Record<string, JSONSerializable>;

export interface MergeStrategy<
  TState extends JSONSerializable = JSONSerializable,
  TMeta extends MergeMeta = MergeMeta,
> {
  /** Initial metadata before any sync or update. */
  initialMeta: TMeta;

  /** Produce meta when this peer sets state (e.g. timestamp, version). */
  createMeta(): TMeta;

  /**
   * Decide how to merge incoming state with current.
   * Return new { state, meta } to apply, or null to keep current.
   */
  merge(
    currentState: TState | null,
    currentMeta: TMeta,
    incomingState: TState | null,
    incomingMeta: TMeta,
    senderId: string
  ): { state: TState | null; meta: TMeta } | null;
}
