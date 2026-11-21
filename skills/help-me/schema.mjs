// JSON Schema helpers shared by every backend. Pure, so tests import them without starting the server.

// OpenAI-style strict schemas want every property required and no extra keys. Optional fields become nullable,
// and dropNulls() removes them again so the page sees the same shape as from the other backends.
export function strict(schema) {
  if (schema.type === "array") return { ...schema, items: strict(schema.items) };
  if (schema.type !== "object") return schema;
  const req = new Set(schema.required || []);
  const properties = {};
  for (const [k, v] of Object.entries(schema.properties || {})) {
    const sv = strict(v);
    properties[k] = req.has(k) ? sv : { anyOf: [sv, { type: "null" }] };
  }
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
export const dropNulls = v =>
  Array.isArray(v)
    ? v.map(dropNulls)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, x]) => x !== null)
            .map(([k, x]) => [k, dropNulls(x)]),
        )
      : v;

// Covers only the keywords the schemas in this file use (type, enum, required, properties, items).
export function check(v, schema, at = "reply") {
  const t = schema.type;
  const ok =
    t === "object"
      ? v !== null && typeof v === "object" && !Array.isArray(v)
      : t === "array"
        ? Array.isArray(v)
        : t === "integer"
          ? Number.isInteger(v)
          : t === "number"
            ? Number.isFinite(v)
            : typeof v === t;
  if (!ok) throw new Error(`${at} should be ${t}, got ${v === null ? "null" : Array.isArray(v) ? "array" : typeof v}`);
  if (schema.enum && !schema.enum.includes(v))
    throw new Error(`${at} should be one of ${schema.enum.join(", ")}, got ${JSON.stringify(v)}`);
  if (t === "array") v.forEach((x, i) => check(x, schema.items, `${at}[${i}]`));
  if (t === "object") {
    for (const k of schema.required || []) if (!(k in v)) throw new Error(`${at}.${k} is missing`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in v) check(v[k], s, `${at}.${k}`);
  }
}
// For backends that only see the schema in the prompt: the model may still wrap its JSON in a code fence.
export function checkedReply(text, schema) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
  let data;
  try {
    data = JSON.parse(fenced ? fenced[1] : text);
  } catch {
    throw new Error("reply is not JSON");
  }
  data = dropNulls(data);
  check(data, schema);
  return data;
}
export const withSchema = (system, schema) =>
  `${system}\n\nReply with one JSON object only, no prose and no code fences, matching this JSON Schema:\n${JSON.stringify(schema)}`;
