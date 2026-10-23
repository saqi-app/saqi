export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    // eslint-disable-next-line no-restricted-syntax -- Unknown JSON primitives must be distinguished without coercion.
    typeof value === "boolean" ||
    // eslint-disable-next-line no-restricted-syntax -- Unknown JSON primitives must be distinguished without coercion.
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  // eslint-disable-next-line no-restricted-syntax -- Finite numbers have distinct canonical JSON encoding.
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("CANONICAL_JSON_NONFINITE");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, canonicalJson).join(",")}]`;
  }
  // eslint-disable-next-line no-restricted-syntax -- Object entries are recursively validated at this serialization boundary.
  if (typeof value === "object") {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-type-assertion -- Object values are unknown at this boundary and recursively validated below.
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("CANONICAL_JSON_UNSUPPORTED");
}
