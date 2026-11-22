import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  ...cloudflare,
  ignorePatterns: [...(cloudflare.ignorePatterns ?? []), "docs/vid"],
  rules: {
    ...cloudflare.rules,
    // Temporary during migration: each rule below is enabled or explained in its own commit.
    "@nkzw/no-instanceof": "off",
    "quality/no-unknown-returns": "off",
    "quality/no-unsafe-dictionary-type": "off",
    "quality/no-known-value-widening": "off",
    "quality/no-conditional-empty-object-spread": "off",
    "quality/no-object-parameters": "off",
    "quality/no-array-filter-map": "off",
    "unicorn/prefer-top-level-await": "off",
  },
  overrides: [
    ...(cloudflare.overrides ?? []),
    {
      // Command-line entry points and dev scripts: the console is how they report.
      files: ["skills/help-me/server.ts", "mcp/server.ts", "scripts/**", "docs/**"],
      rules: { "no-console": "off" },
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
