import assert from "node:assert/strict";
import { test } from "node:test";

import { check, checkedReply, dropNulls, strict, withSchema } from "../skills/help-me/schema.mjs";

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
};

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

test("checkedReply reads JSON wrapped in a code fence", () => {
  assert.deepEqual(checkedReply('Here you go:\n```json\n{"span":"a","kind":"multi"}\n```', choice), {
    span: "a",
    kind: "multi",
  });
});

test("checkedReply refuses prose that is not JSON", () => {
  assert.throws(() => checkedReply("Sure! The span is small.", choice), { message: "reply is not JSON" });
});

test("checkedReply refuses JSON that misses a required field", () => {
  assert.throws(() => checkedReply('{"span":"a"}', choice), { message: "reply.kind is missing" });
});

test("withSchema appends the schema to the system prompt", () => {
  assert.match(withSchema("Be brief.", choice), /^Be brief\.\n\nReply with one JSON object only.*\n\{"type":"object"/s);
});
