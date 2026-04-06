export type CptSearchResult = {
  code: string;
  summary: string | null;
  sourceUrl: string | null;
  error: string | null;
  /** Avg allowable for this code (Snowflake); independent of SRT match. */
  avgAllowable: number | null;
  srt: {
    id: string;
    name: string;
    cptCodes: Array<{
      code: string;
      avgAllowable: number | null;
    }>;
  } | null;
};

export type CptScrapeSlice = {
  code: string;
  summary: string | null;
  sourceUrl: string | null;
  error: string | null;
};

export type CptSrtSlice = {
  id: string;
  name: string;
  cptCodes: string[];
};
