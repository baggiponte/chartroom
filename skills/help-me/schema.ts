// JSON Schema helpers shared by every backend. Pure, so tests import them without starting the server.

/** The part of JSON Schema the prompts use: the same object is sent to the model and checked against its reply. */
export type Schema = StringSchema | NumberSchema | BooleanSchema | ArraySchema | ObjectSchema;
type StringSchema = { readonly type: "string"; readonly enum?: readonly string[] };
type NumberSchema = { readonly type: "number" | "integer" };
type BooleanSchema = { readonly type: "boolean" };
type ArraySchema = { readonly type: "array"; readonly items: Schema };
type ObjectSchema = {
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
            : never;
type InferObject<P, Required> = Flatten<
  { -readonly [K in keyof P & Required]: Infer<P[K]> } & { -readonly [K in Exclude<keyof P, Required>]?: Infer<P[K]> }
>;
type Flatten<T> = { [K in keyof T]: T[K] } & {};

/** What `strict()` sends to OpenAI and Codex: every property required, the optional ones nullable. */
export type StrictSchema =
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

export const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
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

const HAS_TYPE: Record<Schema["type"], (v: unknown) => boolean> = {
  object: isRecord,
  array: Array.isArray,
  integer: Number.isInteger,
  number: Number.isFinite,
  string: v => typeof v === "string",
  boolean: v => typeof v === "boolean",
};

/** Throws, naming the path, unless `v` has the shape of `schema`; afterwards TypeScript knows that shape. */
export function check<S extends Schema>(v: unknown, schema: S, at = "reply"): asserts v is Infer<S> {
  const s: Schema = schema;
  if (!HAS_TYPE[s.type](v)) {
    throw new Error(`${at} should be ${s.type}, got ${typeName(v)}`);
  }
  if (s.type === "string" && s.enum && !s.enum.includes(String(v))) {
    throw new Error(`${at} should be one of ${s.enum.join(", ")}, got ${JSON.stringify(v)}`);
  }
  if (s.type === "array" && Array.isArray(v)) {
    v.forEach((x: unknown, i) => {
      check(x, s.items, `${at}[${String(i)}]`);
    });
  }
  if (s.type === "object" && isRecord(v)) {
    for (const key of s.required ?? []) {
      if (!(key in v)) {
        throw new Error(`${at}.${key} is missing`);
      }
    }
    for (const [key, sub] of Object.entries(s.properties)) {
      if (key in v) {
        check(v[key], sub, `${at}.${key}`);
      }
    }
  }
}

// For backends that only see the schema in the prompt: the model may still wrap its JSON in a code fence.
export function checkedReply<S extends Schema>(text: string, schema: S): Infer<S> {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced?.[1] ?? text);
  } catch {
    throw new Error("reply is not JSON");
  }
  const data = dropNulls(parsed);
  check(data, schema);
  return data;
}

export const withSchema = (system: string, schema: Schema): string =>
  `${system}\n\nReply with one JSON object only, no prose and no code fences, matching this JSON Schema:\n${JSON.stringify(schema)}`;
