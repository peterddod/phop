import { describe, expect, test } from 'vitest';
import { electHost, isCutOff, presentCandidates, shouldAdoptSnapshot } from '../core/host-election';

describe('electHost', () => {
  test('elects lowest-sorted present match player', () => {
    expect(electHost(['c', 'a', 'b'], ['a', 'b', 'c'])).toBe('a');
  });

  test('skips absent host and elects next present', () => {
    // 'a' would win but is absent; 'b' is the lowest present.
    expect(electHost(['a', 'b', 'c'], ['b', 'c'])).toBe('b');
  });

  test('returns null when no match player is present', () => {
    expect(electHost(['a', 'b'], ['x', 'y'])).toBeNull();
  });

  test('returns null on empty match players', () => {
    expect(electHost([], ['a', 'b'])).toBeNull();
  });

  test('does not mutate inputs', () => {
    const matchPlayers = ['c', 'a', 'b'];
    const present = ['b', 'a', 'c'];
    const matchCopy = [...matchPlayers];
    const presentCopy = [...present];
    electHost(matchPlayers, present);
    expect(matchPlayers).toEqual(matchCopy);
    expect(present).toEqual(presentCopy);
  });

  test('is deterministic across shuffled inputs', () => {
    const orderings = [
      electHost(['a', 'b', 'c'], ['a', 'b', 'c']),
      electHost(['c', 'b', 'a'], ['c', 'a', 'b']),
      electHost(['b', 'c', 'a'], ['b', 'a', 'c']),
    ];
    expect(new Set(orderings)).toEqual(new Set(['a']));
  });
});

describe('presentCandidates', () => {
  test('includes self and filters to room membership', () => {
    const result = presentCandidates(['self', 'a', 'b', 'gone'], 'self', ['a', 'b']);
    expect(result).toEqual(['self', 'a', 'b']);
  });

  test('self is included even when not in roomPeers', () => {
    expect(presentCandidates(['self', 'a'], 'self', [])).toEqual(['self']);
  });

  test('drops match players absent from room', () => {
    expect(presentCandidates(['a', 'b', 'c'], 'a', ['b'])).toEqual(['a', 'b']);
  });

  test('preserves matchPlayers order', () => {
    expect(presentCandidates(['c', 'a', 'b'], 'c', ['a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  test('does not mutate inputs', () => {
    const matchPlayers = ['a', 'b', 'c'];
    const roomPeers = ['b', 'c'];
    const matchCopy = [...matchPlayers];
    const peersCopy = [...roomPeers];
    presentCandidates(matchPlayers, 'a', roomPeers);
    expect(matchPlayers).toEqual(matchCopy);
    expect(roomPeers).toEqual(peersCopy);
  });
});

describe('isCutOff', () => {
  const players = ['a', 'b', 'c'];
  const active = new Set(players);

  test('all other active players gone at once → cut off', () => {
    expect(isCutOff(players, 'a', [], active)).toBe(true);
  });

  test('one rival still present → not cut off', () => {
    expect(isCutOff(players, 'a', ['c'], active)).toBe(false);
  });

  test('a single remaining rival leaving is treated as them leaving', () => {
    expect(isCutOff(['a', 'b'], 'a', [], new Set(['a', 'b']))).toBe(false);
    // c already eliminated: b is the only active rival.
    expect(isCutOff(players, 'a', [], new Set(['a', 'b']))).toBe(false);
  });
});

describe('shouldAdoptSnapshot', () => {
  const base = {
    selfId: 'b',
    senderId: 'a',
    hostId: 'a',
    currentHost: 'a',
    candidates: ['a', 'b', 'c'],
    tick: 10,
    lastAppliedTick: 5,
    ownTick: 5,
    handoverFrom: null,
    maxHandoverTick: 100,
  };

  test('non-host adopts a newer snapshot from the current host', () => {
    expect(shouldAdoptSnapshot(base)).toBe(true);
    expect(shouldAdoptSnapshot({ ...base, tick: 5 })).toBe(false);
  });

  test('rejects a snapshot whose body names a host other than the real sender', () => {
    expect(shouldAdoptSnapshot({ ...base, senderId: 'c' })).toBe(false);
  });

  test('rejects snapshots from a non-host or a non-player', () => {
    expect(shouldAdoptSnapshot({ ...base, senderId: 'c', hostId: 'c' })).toBe(false);
    expect(shouldAdoptSnapshot({ ...base, senderId: 'x', hostId: 'x', currentHost: 'x' })).toBe(
      false
    );
  });

  test("a promoted host adopts only the expected previous host's handover", () => {
    const promoted = {
      ...base,
      selfId: 'a',
      currentHost: 'a',
      senderId: 'b',
      hostId: 'b',
      handoverFrom: 'b',
    };
    expect(shouldAdoptSnapshot({ ...promoted, tick: 20, ownTick: 12 })).toBe(true);
    // Behind us.
    expect(shouldAdoptSnapshot({ ...promoted, tick: 10, ownTick: 12 })).toBe(false);
    // Window closed.
    expect(shouldAdoptSnapshot({ ...promoted, handoverFrom: null, tick: 20, ownTick: 12 })).toBe(
      false
    );
    // Another player posing as the previous host.
    expect(
      shouldAdoptSnapshot({ ...promoted, senderId: 'c', hostId: 'c', tick: 20, ownTick: 12 })
    ).toBe(false);
    // Implausibly far ahead.
    expect(shouldAdoptSnapshot({ ...promoted, tick: 101, ownTick: 12 })).toBe(false);
  });
});
