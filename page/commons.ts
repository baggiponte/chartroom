import { type Infer, check, isRecord } from "../skills/help-me/schema.ts";

const STRING = { type: "string" } as const;
const PAGE = {
  type: "object",
  required: ["index", "title"],
  properties: {
    index: { type: "number" },
    title: STRING,
    imageinfo: {
      type: "array",
      items: { type: "object", properties: { thumburl: STRING, descriptionurl: STRING, mime: STRING } },
    },
  },
} as const;
type Page = Infer<typeof PAGE>;

function isPage(p: unknown): p is Page {
  try {
    check(p, PAGE);
    return true;
  } catch {
    return false;
  }
}

export interface Picture {
  src: string;
  page: string;
  title: string;
}

/** The first bitmap a Commons search for `q` finds, or null. */
export async function commonsImage(q: string): Promise<Picture | null> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrnamespace: "6",
    gsrlimit: "6",
    gsrsearch: q + " filetype:bitmap",
    prop: "imageinfo",
    iiprop: "url|mime",
    iiurlwidth: "480",
  });
  const r = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, {
    signal: AbortSignal.timeout(7000),
  });
  const j: unknown = await r.json();
  // the pages come keyed by page id, in no particular order
  const byId = isRecord(j) && isRecord(j["query"]) ? j["query"]["pages"] : undefined;
  const pages = Object.values(isRecord(byId) ? byId : {})
    .filter(isPage)
    .toSorted((a, b) => a.index - b.index);
  for (const pg of pages) {
    const ii = pg.imageinfo?.[0];
    if (ii?.thumburl && /jpeg|png|webp/.test(ii.mime ?? "")) {
      return { src: ii.thumburl, page: ii.descriptionurl ?? "", title: pg.title.replace(/^File:/, "") };
    }
  }
  return null;
}
