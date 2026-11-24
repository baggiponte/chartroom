import assert from "node:assert/strict";
import { test } from "node:test";

import { check, dropNulls, parseFenced, strict, withSchema } from "../skills/chartroom/schema.ts";
import type { Schema } from "../skills/chartroom/schema.ts";

const choice = {
  type: "object",
  required: ["span", "kind"],
  properties: {
    span: { type: "string" },
    kind: { type: "string", enum: ["single", "multi"] },
    options: {
      type: "array",
      items: { type: "object", required: ["label"], properties: { label: { type: "string" } } },
    },
  },
} as const satisfies Schema;

test("strict makes every property required and turns the optional ones nullable", () => {
  assert.deepEqual(strict(choice), {
    type: "object",
    required: ["span", "kind", "options"],
    additionalProperties: false,
    properties: {
      span: { type: "string" },
      kind: { type: "string", enum: ["single", "multi"] },
      options: {
        anyOf: [
          {
            type: "array",
            items: {
              type: "object",
              required: ["label"],
              additionalProperties: false,
              properties: { label: { type: "string" } },
            },
          },
          { type: "null" },
        ],
      },
    },
  });
});

test("dropNulls removes the nulls a strict schema forces, at any depth", () => {
  assert.deepEqual(dropNulls({ a: null, b: [{ c: null, d: 1 }], e: "x" }), { b: [{ d: 1 }], e: "x" });
});

test("check accepts a reply that matches the schema", () => {
  assert.doesNotThrow(() => check({ span: "small", kind: "single", options: [{ label: "Tiny" }] }, choice));
});

test("check names the path of a missing field", () => {
  assert.throws(() => check({ kind: "single" }, choice), { message: "reply.span is missing" });
});

test("check names the path of a wrong type deep inside an array", () => {
  assert.throws(() => check({ span: "a", kind: "single", options: [{ label: 3 }] }, choice), {
    message: "reply.options[0].label should be string, got number",
  });
});

test("check rejects a value outside an enum", () => {
  assert.throws(() => check({ span: "a", kind: "slider" }, choice), {
    message: 'reply.kind should be one of single, multi, got "slider"',
  });
});

test("check deletes the keys the schema doesn't name, at any depth", () => {
  const reply = { span: "a", kind: "single", stray: 1, options: [{ label: "Tiny", text: "tiny" }] };
  check(reply, choice);
  assert.deepEqual(reply, { span: "a", kind: "single", options: [{ label: "Tiny" }] });
});

const STRING = { type: "string" } as const;
const tagged = {
  anyOf: [
    { type: "object", required: ["type", "span"], properties: { type: { type: "string", enum: ["a"] }, span: STRING } },
    {
      type: "object",
      required: ["type", "token"],
      properties: { type: { type: "string", enum: ["b"] }, token: STRING },
    },
  ],
} as const satisfies Schema;

test("anyOf keeps the keys of the branch that fits, even when an earlier branch would have deleted them", () => {
  const reply = { type: "b", token: "x", stray: 1 };
  check(reply, tagged);
  assert.deepEqual(reply, { type: "b", token: "x" });
});

test("anyOf names every branch's complaint when none fits", () => {
  assert.throws(() => check({ type: "b" }, tagged), {
    message: "reply fits none of its shapes: reply.span is missing; reply.token is missing",
  });
});

test("an empty schema accepts anything and leaves it as it is", () => {
  const value = { any: ["thing"] };
  check(value, {});
  assert.deepEqual(value, { any: ["thing"] });
});

test("parseFenced reads JSON wrapped in a code fence", () => {
  assert.deepEqual(parseFenced('Here you go:\n```json\n{"span":"a","kind":"multi"}\n```'), {
    span: "a",
    kind: "multi",
  });
});

test("parseFenced refuses prose that is not JSON", () => {
  assert.throws(() => parseFenced("Sure! The span is small."), { message: "reply is not JSON" });
});

test("withSchema appends the schema to the system prompt", () => {
  assert.match(withSchema("Be brief.", choice), /^Be brief\.\n\nReply with one JSON object only.*\n\{"type":"object"/s);
});
