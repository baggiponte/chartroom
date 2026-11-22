// JSON Schema helpers shared by every backend. Pure, so tests import them without starting the server.
// Not Zod: the skill runs straight from its folder with no install step, so it can't have runtime dependencies,
// and the same plain object doubles as the JSON Schema the model is given.

/** The part of JSON Schema the prompts use: the same object is sent to the model and checked against its reply. */
export type Schema = AnySchema | StringSchema | NumberSchema | BooleanSchema | ArraySchema | ObjectSchema;
/** Anything goes: for the parts of a backend's envelope that are passed on unread. */
type AnySchema = { readonly type?: never };
type StringSchema = { readonly type: "string"; readonly enum?: readonly string[] };
type NumberSchema = { readonly type: "number" | "integer" };
type BooleanSchema = { readonly type: "boolean" };
type ArraySchema = { readonly type: "array"; readonly items: Schema };
export type ObjectSchema = {
  readonly type: "object";
  readonly properties: { readonly [key: string]: Schema };
  readonly required?: readonly string[];
};

/** The TypeScript type of a value that passes `check(value, S)`, so a schema is written once and never retyped. */
export type Infer<S> = S extends { readonly type: "string"; readonly enum: readonly (infer E)[] }
  ? E
  : S extends StringSchema
    ? string
    : S extends NumberSchema
      ? number
      : S extends BooleanSchema
        ? boolean
        : S extends { readonly type: "array"; readonly items: infer I }
          ? Infer<I>[]
          : S extends { readonly type: "object"; readonly properties: infer P }
            ? InferObject<P, S extends { readonly required: readonly (infer R)[] } ? R : never>
            : unknown;
type InferObject<P, Required> = Flatten<
  { -readonly [K in keyof P & Required]: Infer<P[K]> } & { -readonly [K in Exclude<keyof P, Required>]?: Infer<P[K]> }
>;
type Flatten<T> = { [K in keyof T]: T[K] } & {};

/** What `strict()` sends to OpenAI and Codex: every property required, the optional ones nullable. */
export type StrictSchema =
  | AnySchema
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | { readonly type: "null" }
  | { readonly anyOf: readonly StrictSchema[] }
  | { readonly type: "array"; readonly items: StrictSchema }
  | {
      readonly type: "object";
      readonly properties: { readonly [key: string]: StrictSchema };
      readonly required: readonly string[];
      readonly additionalProperties: false;
    };

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// OpenAI-style strict schemas want every property required and no extra keys. Optional fields become nullable,
// and dropNulls() removes them again so the page sees the same shape as from the other backends.
export function strict(schema: Schema): StrictSchema {
  if (schema.type === "array") {
    return { ...schema, items: strict(schema.items) };
  }
  if (schema.type !== "object") {
    return schema;
  }
  const required = new Set(schema.required);
  const properties: Record<string, StrictSchema> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    const s = strict(value);
    properties[key] = required.has(key) ? s : { anyOf: [s, { type: "null" }] };
  }
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export const dropNulls = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(dropNulls)
    : isRecord(v)
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, x]) => x !== null)
            .map(([k, x]) => [k, dropNulls(x)]),
        )
      : v;

const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * Throws, naming the path, unless `v` has the shape of `schema`. Keys the schema doesn't name are deleted, so what
 * TypeScript knows afterwards is all there is.
 */
export function check<S extends Schema>(v: unknown, schema: S, at = "reply"): asserts v is Infer<S> {
  const s: Schema = schema;
  if (s.type === undefined) {
    return;
  }
  const wrong = new Error(`${at} should be ${s.type}, got ${typeName(v)}`);
  switch (s.type) {
    case "string":
      if (typeof v !== "string") {
        throw wrong;
      }
      if (s.enum && !s.enum.includes(v)) {
        throw new Error(`${at} should be one of ${s.enum.join(", ")}, got ${JSON.stringify(v)}`);
      }
      return;
    case "number":
    case "integer":
      if (!(s.type === "integer" ? Number.isInteger(v) : Number.isFinite(v))) {
        throw wrong;
      }
      return;
    case "boolean":
      if (typeof v !== "boolean") {
        throw wrong;
      }
      return;
    case "array":
      if (!Array.isArray(v)) {
        throw wrong;
      }
      v.forEach((x: unknown, i) => {
        check(x, s.items, `${at}[${String(i)}]`);
      });
      return;
    case "object": {
      if (!isRecord(v)) {
        throw wrong;
      }
      const missing = s.required?.find(key => !(key in v));
      if (missing !== undefined) {
        throw new Error(`${at}.${missing} is missing`);
      }
      for (const key of Object.keys(v)) {
        const sub: Schema | undefined = Object.hasOwn(s.properties, key) ? s.properties[key] : undefined;
        if (sub === undefined) {
          delete v[key];
        } else {
          check(v[key], sub, `${at}.${key}`);
        }
      }
    }
  }
}

// For backends that only see the schema in the prompt: the model may still wrap its JSON in a code fence.
export function parseFenced(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  try {
    return JSON.parse(fenced?.[1] ?? text);
  } catch {
    throw new Error("reply is not JSON");
  }
}

export const withSchema = (system: string, schema: Schema): string =>
  `${system}\n\nReply with one JSON object only, no prose and no code fences, matching this JSON Schema:\n${JSON.stringify(schema)}`;
