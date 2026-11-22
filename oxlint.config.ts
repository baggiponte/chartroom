import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  ...cloudflare,
  ignorePatterns: [...(cloudflare.ignorePatterns ?? []), "docs/vid"],
  rules: {
    ...cloudflare.rules,
    // Temporary during migration: each rule below is enabled or explained in its own commit.
    "quality/no-unknown-returns": "off",
    "quality/no-unsafe-dictionary-type": "off",
    "quality/no-known-value-widening": "off",
    "quality/no-conditional-empty-object-spread": "off",
    "quality/no-object-parameters": "off",
    "quality/no-array-filter-map": "off",
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
