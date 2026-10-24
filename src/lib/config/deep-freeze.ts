/**
 * A value whose objects and arrays are read-only all the way down.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T

/**
 * Freezes a plain object or array and everything reachable from it, and
 * returns the same value. Configuration modules use it so that no caller can
 * change shared settings at runtime (HARDENING_CONSTRAINTS.md section 3, HC3).
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  freezeAll(value, new WeakSet())
  return value as DeepReadonly<T>
}

function freezeAll(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    freezeAll((value as Record<PropertyKey, unknown>)[key], seen)
  }
  Object.freeze(value)
}

/** True when the value and every object or array reachable from it are frozen. */
export function isDeepFrozen(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true
  if (!Object.isFrozen(value)) return false
  seen.add(value)
  return Reflect.ownKeys(value).every((key) =>
    isDeepFrozen((value as Record<PropertyKey, unknown>)[key], seen)
  )
}
