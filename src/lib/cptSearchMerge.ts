import type { CptSearchResult, CptScrapeSlice, CptSrtSlice } from "./cptSearchTypes";

export function mergeCptSearchParts(
  codes: string[],
  scrape: CptScrapeSlice[] | null,
  srt: Record<string, CptSrtSlice | null> | null,
  avg: Record<string, number | null> | null,
): CptSearchResult[] {
  const scrapeByCode = new Map<string, CptScrapeSlice>();
  if (scrape) {
    for (const row of scrape) {
      scrapeByCode.set(row.code.toUpperCase(), row);
    }
  }

  const srtSafe = srt ?? {};
  const avgSafe = avg ?? {};

  return codes.map((c) => {
    const u = c.toUpperCase();
    const sc = scrapeByCode.get(u);
    const srtSlice = srtSafe[u];

    let srtFull: CptSearchResult["srt"] = null;
    if (srtSlice) {
      srtFull = {
        id: srtSlice.id,
        name: srtSlice.name,
        cptCodes: srtSlice.cptCodes.map((code) => ({
          code,
          avgAllowable: avgSafe[code.toUpperCase()] ?? null,
        })),
      };
    }

    return {
      code: u,
      summary: sc?.summary ?? null,
      sourceUrl: sc?.sourceUrl ?? null,
      error: sc?.error ?? null,
      avgAllowable: avgSafe[u] ?? null,
      srt: srtFull,
    };
  });
}
