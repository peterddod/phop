/**
 * A small diff/patch for plain JSON values, used for hosted-simulation
 * snapshot deltas.
 *
 * A patch is a list of operations applied in order. A path is a list of
 * object keys (strings) and array indexes (numbers) from the root.
 *
 * - `[0, path, value]` sets the value at `path` (the root for `[]`).
 * - `[1, path]` deletes the object key at `path`.
 * - `[2, path, start, deleteCount, items]` splices the array at `path`.
 *
 * Applying `diffJson(a, b)` to `a` gives a value that serialises exactly
 * like `b`, object key order included, so hosts and receivers stay
 * byte-identical. Both values must be plain JSON (e.g. fresh from
 * `JSON.parse`): no `undefined`, functions, class instances or non-finite
 * numbers.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonPath = (string | number)[];

export type JsonPatchOp =
  | [0, JsonPath, JsonValue]
  | [1, JsonPath]
  | [2, JsonPath, number, number, JsonValue[]];

export type JsonPatch = JsonPatchOp[];

/**
 * An array element's identity, or undefined if it has none. Arrays whose
 * elements (before and after) all have one are diffed by identity, so an
 * insertion or removal doesn't rewrite every element after it. `path` is
 * reused between calls; copy it to keep it.
 */
export type GetJsonId = (item: JsonValue, path: JsonPath) => string | number | undefined;

/** The default identity: an object's `id` field, if it is a string or a number. */
export const defaultGetId: GetJsonId = (item) => {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
  const id = item.id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
};

type JsonObject = { [key: string]: JsonValue };

// biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn is ES2022; the library targets ES2020.
const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep equality of two JSON values, object key order included. */
function equal(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const key = keysA[i];
    if (key !== keysB[i] || !equal(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Whether setting `b`'s new keys on `a` (minus its deleted keys) gives
 * `b`'s key order: the kept keys in the same order, the new ones last.
 */
function keepsKeyOrder(a: JsonObject, b: JsonObject, keysA: string[], keysB: string[]): boolean {
  let ai = 0;
  let added = false;
  for (const key of keysB) {
    if (!hasOwn(a, key)) {
      added = true;
      continue;
    }
    if (added) return false;
    while (ai < keysA.length && keysA[ai] !== key) {
      if (hasOwn(b, keysA[ai])) return false;
      ai++;
    }
    ai++;
  }
  return true;
}

/** The operations that turn `a` into `b`. Empty when they are equal. */
export function diffJson(a: JsonValue, b: JsonValue, getId: GetJsonId = defaultGetId): JsonPatch {
  const ops: JsonPatch = [];
  diffValue(a, b, [], ops, getId);
  return ops;
}

// `path` is one stack shared by the whole walk (pushed before recursing,
// popped after), so it is copied only into the operations that keep it.
function diffValue(a: JsonValue, b: JsonValue, path: JsonPath, ops: JsonPatch, getId: GetJsonId) {
  if (a === b) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    diffArray(a, b, path, ops, getId);
  } else if (isObject(a) && isObject(b)) {
    diffObject(a, b, path, ops, getId);
  } else {
    ops.push([0, path.slice(), b]);
  }
}

function diffObject(
  a: JsonObject,
  b: JsonObject,
  path: JsonPath,
  ops: JsonPatch,
  getId: GetJsonId
) {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (!keepsKeyOrder(a, b, keysA, keysB)) {
    ops.push([0, path.slice(), b]);
    return;
  }
  for (const key of keysA) if (!hasOwn(b, key)) ops.push([1, [...path, key]]);
  for (const key of keysB) {
    if (!hasOwn(a, key)) {
      ops.push([0, [...path, key], b[key]]);
      continue;
    }
    path.push(key);
    diffValue(a[key], b[key], path, ops, getId);
    path.pop();
  }
}

function idsOf(items: JsonValue[], path: JsonPath, getId: GetJsonId): (string | number)[] | null {
  const ids: (string | number)[] = [];
  for (const item of items) {
    const id = getId(item, path);
    if (id === undefined) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * Arrays of the same length (and, when keyed, the same ids in order) are
 * diffed element by element. Otherwise the unchanged run at each end is
 * kept and the middle spliced; a keyed array's kept elements are then
 * diffed in place.
 */
function diffArray(
  a: JsonValue[],
  b: JsonValue[],
  path: JsonPath,
  ops: JsonPatch,
  getId: GetJsonId
) {
  const idsA = a.length > 0 ? idsOf(a, path, getId) : null;
  const idsB = idsA && b.length > 0 ? idsOf(b, path, getId) : null;
  const keyed = idsA !== null && idsB !== null;
  const same = keyed
    ? (i: number, j: number) => idsA[i] === idsB[j]
    : (i: number, j: number) => equal(a[i], b[j]);

  if (a.length === b.length && (!keyed || idsA.every((id, i) => id === idsB[i]))) {
    for (let i = 0; i < a.length; i++) diffAt(a[i], b[i], i, path, ops, getId);
    return;
  }
  const shortest = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < shortest && same(prefix, prefix)) prefix++;
  let suffix = 0;
  while (suffix < shortest - prefix && same(a.length - 1 - suffix, b.length - 1 - suffix)) {
    suffix++;
  }
  if (prefix + suffix === 0) {
    ops.push([0, path.slice(), b]);
    return;
  }
  ops.push([
    2,
    path.slice(),
    prefix,
    a.length - prefix - suffix,
    b.slice(prefix, b.length - suffix),
  ]);
  if (!keyed) return;
  for (let i = 0; i < prefix; i++) diffAt(a[i], b[i], i, path, ops, getId);
  for (let k = 1; k <= suffix; k++) {
    diffAt(a[a.length - k], b[b.length - k], b.length - k, path, ops, getId);
  }
}

function diffAt(
  a: JsonValue,
  b: JsonValue,
  index: number,
  path: JsonPath,
  ops: JsonPatch,
  getId: GetJsonId
) {
  path.push(index);
  diffValue(a, b, path, ops, getId);
  path.pop();
}

// ---------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------

export class JsonPatchError extends Error {}

const isIndex = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/** Whether `data` is shaped like a patch. `applyJsonPatch` checks the rest. */
export function isJsonPatch(data: unknown): data is JsonPatch {
  if (!Array.isArray(data)) return false;
  for (const op of data) {
    if (!Array.isArray(op)) return false;
    const path: unknown = op[1];
    if (!Array.isArray(path)) return false;
    for (const key of path) if (typeof key !== 'string' && !isIndex(key)) return false;
    switch (op[0]) {
      case 0:
        if (op.length !== 3) return false;
        break;
      case 1:
        if (op.length !== 2 || path.length === 0) return false;
        break;
      case 2:
        if (op.length !== 5 || !isIndex(op[2]) || !isIndex(op[3]) || !Array.isArray(op[4])) {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * `patch` applied to `base`, without changing `base`: containers along the
 * changed paths are copied, everything else is shared with `base`. Throws
 * `JsonPatchError` if an operation doesn't fit `base`.
 */
export function applyJsonPatch(base: JsonValue, patch: JsonPatch): JsonValue {
  // Containers copied by this call, which later operations may change in place.
  const copied = new WeakSet<object>();
  const own = <T extends JsonValue[] | JsonObject>(value: T): T => {
    if (copied.has(value)) return value;
    const copy = (Array.isArray(value) ? value.slice() : { ...value }) as T;
    copied.add(copy);
    return copy;
  };

  let root = base;
  for (const op of patch) {
    const path = op[1];
    if (path.length === 0) {
      if (op[0] === 0) {
        root = op[2];
        continue;
      }
      if (op[0] === 2 && Array.isArray(root)) {
        root = own(root);
        splice(root, op[2], op[3], op[4]);
        continue;
      }
      throw new JsonPatchError('phop: bad patch operation at the root');
    }
    if (typeof root !== 'object' || root === null) {
      throw new JsonPatchError('phop: patch path into a non-container');
    }
    root = own(root);
    let parent: JsonValue[] | JsonObject = root;
    for (let i = 0; i < path.length - 1; i++) {
      const child = own(container(get(parent, path[i])));
      set(parent, path[i], child);
      parent = child;
    }
    const key = path[path.length - 1];
    switch (op[0]) {
      case 0:
        if (Array.isArray(parent)) get(parent, key);
        set(parent, key, op[2]);
        break;
      case 1:
        if (Array.isArray(parent) || typeof key !== 'string' || !hasOwn(parent, key)) {
          throw new JsonPatchError('phop: patch deletes a missing key');
        }
        delete parent[key];
        break;
      case 2: {
        const target = container(get(parent, key));
        if (!Array.isArray(target)) throw new JsonPatchError('phop: patch splices a non-array');
        const copy = own(target);
        splice(copy, op[2], op[3], op[4]);
        set(parent, key, copy);
        break;
      }
    }
  }
  return root;
}

function container(value: JsonValue): JsonValue[] | JsonObject {
  if (typeof value !== 'object' || value === null) {
    throw new JsonPatchError('phop: patch path into a non-container');
  }
  return value;
}

function get(parent: JsonValue[] | JsonObject, key: string | number): JsonValue {
  if (Array.isArray(parent)) {
    if (typeof key !== 'number' || key >= parent.length) {
      throw new JsonPatchError('phop: patch index out of range');
    }
    return parent[key];
  }
  if (typeof key !== 'string' || !hasOwn(parent, key)) {
    throw new JsonPatchError('phop: patch path through a missing key');
  }
  return parent[key];
}

function set(parent: JsonValue[] | JsonObject, key: string | number, value: JsonValue) {
  if (Array.isArray(parent)) {
    parent[key as number] = value;
  } else if (typeof key !== 'string') {
    throw new JsonPatchError('phop: patch indexes an object');
  } else if (key === '__proto__') {
    // An own property, as JSON.parse makes it, never the prototype.
    Object.defineProperty(parent, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    parent[key] = value;
  }
}

function splice(array: JsonValue[], start: number, deleteCount: number, items: JsonValue[]) {
  if (start + deleteCount > array.length) {
    throw new JsonPatchError('phop: patch splice out of range');
  }
  // Not `splice(start, n, ...items)`: a long `items` would overflow the call stack.
  const tail = array.slice(start + deleteCount);
  array.length = start;
  for (const item of items) array.push(item);
  for (const item of tail) array.push(item);
}
