import { describe, expect, it } from 'vitest';
import {
  applyJsonPatch,
  diffJson,
  isJsonPatch,
  type JsonPatch,
  JsonPatchError,
  type JsonValue,
} from '../core/json-diff';

/** Seeded PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValue(r: () => number, depth: number): JsonValue {
  const pick = r();
  if (depth <= 0 || pick < 0.4) {
    const p = r();
    if (p < 0.2) return null;
    if (p < 0.4) return r() < 0.5;
    if (p < 0.7) return Math.round(r() * 100) / 10;
    return `s${Math.floor(r() * 5)}`;
  }
  if (pick < 0.7) {
    const keyed = r() < 0.5;
    return Array.from({ length: Math.floor(r() * 5) }, (_, i) =>
      keyed ? { id: `e${i}`, v: randomValue(r, depth - 1) } : randomValue(r, depth - 1)
    );
  }
  const object: { [key: string]: JsonValue } = {};
  for (let i = Math.floor(r() * 5); i > 0; i--) {
    object[`k${Math.floor(r() * 6)}`] = randomValue(r, depth - 1);
  }
  return object;
}

/** A random edit of `value`: change, add, delete, reorder, insert or remove. */
function mutate(r: () => number, value: JsonValue, depth: number): JsonValue {
  if (typeof value !== 'object' || value === null || r() < 0.15) {
    return r() < 0.8 ? randomValue(r, depth) : value;
  }
  if (Array.isArray(value)) {
    const next = value.map((item) => (r() < 0.3 ? mutate(r, item, depth - 1) : item));
    const p = r();
    if (p < 0.2) next.splice(Math.floor(r() * (next.length + 1)), 0, randomValue(r, depth - 1));
    else if (p < 0.4 && next.length > 0) next.splice(Math.floor(r() * next.length), 1);
    else if (p < 0.5) next.shift();
    else if (p < 0.55) next.reverse();
    return next;
  }
  const entries = Object.entries(value).filter(() => r() > 0.15);
  const next: { [key: string]: JsonValue } = {};
  if (r() < 0.1) entries.reverse();
  for (const [key, item] of entries) next[key] = r() < 0.4 ? mutate(r, item, depth - 1) : item;
  if (r() < 0.3) next[`k${Math.floor(r() * 9)}`] = randomValue(r, depth - 1);
  return next;
}

/** Diff, send through JSON like the wire does, apply. */
function roundTrip(a: JsonValue, b: JsonValue): JsonValue {
  const patch = JSON.parse(JSON.stringify(diffJson(a, b))) as unknown;
  expect(isJsonPatch(patch)).toBe(true);
  return applyJsonPatch(a, patch as JsonPatch);
}

describe('json diff', () => {
  it('reproduces the target byte for byte, key order included, without touching the base', () => {
    const r = rng(42);
    for (let i = 0; i < 3000; i++) {
      const a = randomValue(r, 4);
      const b = mutate(r, a, 4);
      const before = JSON.stringify(a);
      expect(JSON.stringify(roundTrip(a, b))).toBe(JSON.stringify(b));
      expect(JSON.stringify(a)).toBe(before);
    }
  });

  it('is empty for equal values and shares unchanged subtrees', () => {
    const a = { units: { u1: { hp: 3 }, u2: { hp: 5 } }, tick: 1 };
    expect(diffJson(a, JSON.parse(JSON.stringify(a)))).toEqual([]);
    const b = JSON.parse(JSON.stringify(a));
    b.units.u2.hp = 4;
    b.tick = 2;
    const patch = diffJson(a, b);
    expect(patch).toEqual([
      [0, ['units', 'u2', 'hp'], 4],
      [0, ['tick'], 2],
    ]);
    const out = applyJsonPatch(a, patch) as typeof a;
    expect(out.units.u1).toBe(a.units.u1);
    expect(out.units.u2).not.toBe(a.units.u2);
  });

  it('diffs arrays of entities by id', () => {
    const a = {
      list: [
        { id: 'a', x: 1 },
        { id: 'b', x: 2 },
        { id: 'c', x: 3 },
      ],
    };
    const b = {
      list: [
        { id: 'a', x: 1 },
        { id: 'c', x: 4 },
      ],
    };
    expect(diffJson(a, b)).toEqual([
      [2, ['list'], 1, 1, []],
      [0, ['list', 1, 'x'], 4],
    ]);
    // Custom identity: by `key`.
    const c: JsonValue = { list: [{ key: 1 }, { key: 2, n: 1 }] };
    const d: JsonValue = { list: [{ key: 0 }, { key: 1 }, { key: 2, n: 2 }] };
    const byKey = (item: JsonValue) =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
        ? (item.key as number)
        : undefined;
    const patch = diffJson(c, d, byKey);
    expect(patch).toEqual([
      [2, ['list'], 0, 0, [{ key: 0 }]],
      [0, ['list', 2, 'n'], 2],
    ]);
    expect(applyJsonPatch(c, patch)).toEqual(d);
  });

  it('gives every operation its own path, deep in nested keyed splices', () => {
    const a: JsonValue = {
      w: {
        units: [
          { id: 1, pos: [0, 0] },
          { id: 2, pos: [1, 1] },
          { id: 3, pos: [2, 2] },
        ],
      },
      t: 1,
    };
    const b: JsonValue = {
      w: {
        units: [
          { id: 1, pos: [0, 5] },
          { id: 3, pos: [2, 2], hp: 4 },
        ],
      },
      t: 2,
    };
    const paths: JsonValue[] = [];
    const patch = diffJson(a, b, (item, path) => {
      paths.push(path.slice());
      return (item as { id: number }).id;
    });
    expect(patch).toEqual([
      [2, ['w', 'units'], 1, 1, []],
      [0, ['w', 'units', 0, 'pos', 1], 5],
      [0, ['w', 'units', 1, 'hp'], 4],
      [0, ['t'], 2],
    ]);
    expect(new Set(paths.map((p) => JSON.stringify(p)))).toEqual(
      new Set(['["w","units"]', '["w","units",0,"pos"]', '["w","units",1,"pos"]'])
    );
    expect(applyJsonPatch(a, patch)).toEqual(b);
  });

  it('trims the front of a shrinking array with one splice', () => {
    const path = [
      { q: 1, r: 1 },
      { q: 2, r: 1 },
      { q: 3, r: 1 },
    ];
    expect(diffJson({ path }, { path: path.slice(1) })).toEqual([[2, ['path'], 0, 1, []]]);
  });

  it('keeps an own __proto__ key an own key', () => {
    const a = JSON.parse('{"x":{}}') as JsonValue;
    const b = JSON.parse('{"x":{"__proto__":{"polluted":true}}}') as JsonValue;
    const out = roundTrip(a, b) as { x: object };
    expect(JSON.stringify(out)).toBe(JSON.stringify(b));
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out.x)).toBe(Object.prototype);
  });

  it('rejects malformed patches and ones that do not fit the base', () => {
    expect(isJsonPatch({})).toBe(false);
    expect(isJsonPatch([[3, []]])).toBe(false);
    expect(isJsonPatch([[0, [{}], 1]])).toBe(false);
    expect(isJsonPatch([[1, []]])).toBe(false);
    expect(isJsonPatch([[2, ['a'], -1, 0, []]])).toBe(false);
    const base = { a: [1, 2], o: { k: 1 } };
    const bad: JsonPatch[] = [
      [[0, ['missing', 'x'], 1]],
      [[0, ['a', 5], 1]],
      [[0, ['a', 'x'], 1]],
      [[0, ['o', 0], 1]],
      [[1, ['o', 'nope']]],
      [[2, ['o'], 0, 0, []]],
      [[2, ['a'], 1, 5, []]],
      [[0, ['a', 0, 'deep'], 1]],
    ];
    for (const patch of bad) expect(() => applyJsonPatch(base, patch)).toThrow(JsonPatchError);
    expect(base).toEqual({ a: [1, 2], o: { k: 1 } });
  });
});
