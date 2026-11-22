import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  ...cloudflare,
  ignorePatterns: [...(cloudflare.ignorePatterns ?? []), "docs/vid"],
  rules: {
    ...cloudflare.rules,
    // With exactOptionalPropertyTypes, a conditional spread is how a literal passed to a call leaves an optional
    // key out; building the object in steps would need a mutable, wider-typed variable at each site.
    "quality/no-conditional-empty-object-spread": "off",
    // JSON.parse, JSON-RPC replies and the fake model's answers really are unknown; every caller parses them with
    // check() or zod straight away, which is the boundary this rule asks for.
    "quality/no-unknown-returns": "off",
    // Record<string, unknown> is a parsed JSON object before check() narrows it, and a JSON Schema's properties
    // map any key the model may fill to a schema: neither has a narrower value type to give.
    "quality/no-unsafe-dictionary-type": "off",
  },
  overrides: [
    ...(cloudflare.overrides ?? []),
    {
      // Command-line entry points and dev scripts: the console is how they report.
      files: ["skills/help-me/server.ts", "mcp/server.ts", "scripts/**", "docs/**"],
      rules: { "no-console": "off" },
    },
    {
      // The page is bundled as a classic IIFE script, where top-level await is a syntax error.
      files: ["page/**"],
      rules: { "unicorn/prefer-top-level-await": "off" },
    },
    {
      // Browser code: instanceof is how a DOM node or event target narrows to Element, HTMLElement or Text.
      files: ["page/**", "docs/**"],
      rules: { "@nkzw/no-instanceof": "off" },
    },
    {
      // The MCP test client forwards whatever JSON-RPC params a test sends; the server under test validates them.
      files: ["test/**"],
      rules: { "quality/no-object-parameters": "off" },
    },
    {
      // node:test registers tests synchronously and reports their failures itself.
      files: ["**/*.ts"],
      rules: {
        "typescript/no-floating-promises": [
          "error",
          {
            allowForKnownSafeCalls: [
              {
                from: "package",
                package: "node:test",
                name: ["test", "describe", "it", "suite"],
              },
            ],
          },
        ],
      },
    },
  ],
});
