// JavaScript's `$` may also match before a final newline. Payment instruction
// strings must match in full, with no coercion from numbers or other JSON types.
export function matchesInvoiceField(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && value.match(pattern)?.[0] === value;
}
export function pickInvoiceFields<T extends object>(value: T, fields: readonly (keyof T)[]): T {
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) as T;
}
