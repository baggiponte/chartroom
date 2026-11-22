import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface Page {
  html: string;
  /** A hash of the file, written into the page and answered by /api/init. */
  build: string;
}

// Read once at start, so a running server never serves a page newer than its own code, and a page that outlived its
// server can tell from the build hash.
export function readPage(): Page {
  const source = readFileSync(new URL("index.html", import.meta.url), "utf8");
  const build = createHash("sha256").update(source).digest("hex").slice(0, 12);
  return { html: source.replace('"%BUILD%"', JSON.stringify(build)), build };
}
