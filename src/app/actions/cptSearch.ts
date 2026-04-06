"use server";

import Anthropic from "@anthropic-ai/sdk";
import type { Browser } from "puppeteer-core";
import type { SpecificOrgConfig } from "../../lib/cptOrgConfig";
import { launchPuppeteerBrowser } from "../../lib/puppeteerLaunch";
import { isValidContextId } from "../../lib/cptOrgConfig";
import { isPlausibleCptCode, normalizeCodes } from "../../lib/cptSearchCodes";
import { mergeCptSearchParts } from "../../lib/cptSearchMerge";
import type { CptSearchResult, CptScrapeSlice, CptSrtSlice } from "../../lib/cptSearchTypes";
import { runSnowflakeQuery } from "../../lib/snowflake";

export type { CptSearchResult, CptScrapeSlice, CptSrtSlice } from "../../lib/cptSearchTypes";
export type { SpecificOrgConfig } from "../../lib/cptOrgConfig";

type SerperOrganicResult = {
  link?: string;
};

type SerperResponse = {
  organic?: SerperOrganicResult[];
};

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function roundAvgAllowableTwoDecimals(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseAverageAllowable(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? roundAvgAllowableTwoDecimals(value) : null;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? roundAvgAllowableTwoDecimals(parsed) : null;
  }

  return null;
}

type ValidateOutcome =
  | { ok: true; codes: string[] }
  | { ok: false; results: CptSearchResult[] };

function validateSearchCodes(rawCodes: string[]): ValidateOutcome {
  const codes = normalizeCodes(Array.isArray(rawCodes) ? rawCodes : []);

  if (codes.length === 0) {
    return {
      ok: false,
      results: [
        {
          code: "",
          summary: null,
          sourceUrl: null,
          error: "No CPT codes provided.",
          avgAllowable: null,
          srt: null,
        },
      ],
    };
  }

  const invalid = codes.filter((code) => !isPlausibleCptCode(code));
  if (invalid.length > 0) {
    return {
      ok: false,
      results: invalid.map((code) => ({
        code,
        summary: null,
        sourceUrl: null,
        error: "Invalid CPT code format.",
        avgAllowable: null,
        srt: null,
      })),
    };
  }

  return { ok: true, codes };
}

function toScrapeSlices(results: CptSearchResult[]): CptScrapeSlice[] {
  return results.map((r) => ({
    code: r.code,
    summary: r.summary,
    sourceUrl: r.sourceUrl,
    error: r.error,
  }));
}

const SF_SRT_QUERY = (placeholders: string) => `
          SELECT DISTINCT 
            srt_id,
            srt_name,
            procedure_code AS billing_code
          FROM dev_core.consolidated_athena.processed_claims_with_srt
          WHERE srt_id IN (
            SELECT DISTINCT srt_id
            FROM dev_core.consolidated_athena.processed_claims_with_srt
            WHERE procedure_code IN (${placeholders})
            AND srt_id IS NOT NULL
          )
        `;

const SF_AVG_QUERY = (placeholders: string, departmentPlaceholders: string) => `
    WITH _params AS (
      SELECT
        ?::NUMBER AS context_id,
        DATEADD(MONTH, -12, CURRENT_DATE()) AS start_date,
        CURRENT_DATE() AS end_date
    ),

    base_claims AS (
      SELECT DISTINCT
        c.contextid,
        c.claimid,
        c.primaryclaimstatus,
        c.secondaryclaimstatus
      FROM PROD_CORE.BASE_ATHENA.CLAIM c
      JOIN PROD_CORE.BASE_ATHENA.APPOINTMENT a
        ON c.contextid = a.contextid
        AND c.claimappointmentid = a.appointmentid
      CROSS JOIN _params p
      WHERE c.contextid = p.context_id
        AND a.departmentid IN (${departmentPlaceholders})
        AND a.appointmentdate BETWEEN p.start_date AND p.end_date
    ),

    tx_data AS (
      SELECT
        c.claimid,
        REGEXP_REPLACE(
          SPLIT_PART(UPPER(TRIM(cd.procedurecode)), ',', 1),
          '[^A-Z0-9]',
          ''
        ) AS cpt_code,
        CASE
          WHEN t.voideddate IS NULL
            AND c.primaryclaimstatus = 'CLOSED'
            AND c.secondaryclaimstatus = 'CLOSED'
            AND t.transactiontransfertype = 'Primary'
            AND t.transactiontype IN ('CHARGE', 'ADJUSTMENT')
          THEN t.amount
          ELSE NULL
        END AS allowable_amount
      FROM PROD_CORE.BASE_ATHENA.TRANSACTION t
      JOIN base_claims c
        ON t.contextid = c.contextid
        AND t.claimid = c.claimid
      LEFT JOIN PROD_CORE.BASE_ATHENA.CHARGEDETAIL cd
        ON t.parentchargeid = cd.chargeid
        AND t.contextid = cd.contextid
      WHERE cd.procedurecode IS NOT NULL
    ),

    cpt_stats AS (
      SELECT
        cpt_code,
        COUNT(DISTINCT claimid) AS claims_with_cpt,
        AVG(allowable_amount) AS avg_allowable
      FROM tx_data
      GROUP BY cpt_code
    ),

    total_claims AS (
      SELECT COUNT(DISTINCT claimid) AS total_claims
      FROM base_claims
    ),

    srt_clusters AS (
      SELECT
        srt_id,
        srt_name,
        LISTAGG(DISTINCT TRIM(procedure_code), ' | ')
          WITHIN GROUP (ORDER BY TRIM(procedure_code)) AS srt_cpt_set
      FROM prod_core.consolidated_athena.processed_claims_with_srt
      WHERE ehr_context_id = (SELECT context_id FROM _params)
        AND srt_id IS NOT NULL
      GROUP BY srt_id, srt_name
    ),

    srt_lookup AS (
      SELECT
        TRIM(code.value) AS cpt_code,
        LISTAGG(s.srt_id, ' | ')
          WITHIN GROUP (ORDER BY s.srt_id) AS existing_srt_ids,
        LISTAGG(s.srt_name, ' | ')
          WITHIN GROUP (ORDER BY s.srt_id) AS existing_srt_names,
        LISTAGG(
          REPLACE(s.srt_cpt_set, ' | ', ', '),
          ' | '
        ) WITHIN GROUP (ORDER BY s.srt_id) AS cpts_within_this_srt
      FROM srt_clusters s,
        LATERAL FLATTEN(INPUT => SPLIT(s.srt_cpt_set, ' | ')) code
      GROUP BY TRIM(code.value)
    )

    SELECT
      c.cpt_code,
      b.description,
      c.claims_with_cpt,
      c.avg_allowable,
      ROUND(100 * c.claims_with_cpt / NULLIF(tc.total_claims::FLOAT, 0), 2) AS pct_of_all_claims,
      tc.total_claims,
      s.existing_srt_ids,
      s.existing_srt_names,
      s.cpts_within_this_srt
    FROM cpt_stats c
    LEFT JOIN prod_core.base_hex_pricing.billing_code b
      ON c.cpt_code = b.billing_code
    LEFT JOIN srt_lookup s
      ON c.cpt_code = s.cpt_code
    CROSS JOIN total_claims tc
    WHERE c.cpt_code IN (${placeholders})
    ORDER BY
      c.claims_with_cpt DESC,
      c.cpt_code
  `;

type SfRow = {
  BILLING_CODE?: string;
  SRT_ID?: string;
  SRT_NAME?: string;
  billing_code?: string;
  srt_id?: string;
  srt_name?: string;
};

type AvgRow = {
  CPT_CODE?: string;
  cpt_code?: string;
  AVG_ALLOWABLE?: string | number | null;
  avg_allowable?: string | number | null;
};

function buildSrtMapFromRows(sfRows: SfRow[]) {
  const srtMap: Record<string, { id: string; name: string; cptCodes: Set<string> }> = {};
  for (const row of sfRows) {
    const c = (row.BILLING_CODE || row.billing_code)?.toUpperCase();
    const srtId = row.SRT_ID || row.srt_id;
    const srtName = row.SRT_NAME || row.srt_name;

    if (srtId && srtName && c) {
      if (!srtMap[srtId]) {
        srtMap[srtId] = { id: srtId, name: srtName, cptCodes: new Set() };
      }
      srtMap[srtId].cptCodes.add(c);
    }
  }
  return srtMap;
}

function srtSliceForCode(
  codes: string[],
  srtMap: Record<string, { id: string; name: string; cptCodes: Set<string> }>,
): Record<string, CptSrtSlice | null> {
  const out: Record<string, CptSrtSlice | null> = {};
  for (const c of codes) {
    const codeUpper = c.toUpperCase();
    const matchedSrt = Object.values(srtMap).find((srt) => srt.cptCodes.has(codeUpper));
    if (matchedSrt) {
      out[codeUpper] = {
        id: matchedSrt.id,
        name: matchedSrt.name,
        cptCodes: Array.from(matchedSrt.cptCodes).sort(),
      };
    } else {
      out[codeUpper] = null;
    }
  }
  return out;
}

function logSnowflakeAvgQueryReturn(rows: unknown, source: string): void {
  const count = Array.isArray(rows) ? rows.length : 0;
  const payload =
    typeof rows === "object" && rows !== null
      ? JSON.stringify(rows, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        2)
      : String(rows);
  console.log(
    `[${source}] Snowflake avg query full return (${count} row(s)):\n${payload}`,
  );
}

function avgMapFromRows(avgRows: AvgRow[]): Record<string, number | null> {
  const avgAllowableByCode: Record<string, number | null> = {};
  for (const row of avgRows) {
    const c = (row.CPT_CODE || row.cpt_code)?.toUpperCase();
    if (!c) continue;
    avgAllowableByCode[c] = parseAverageAllowable(
      row.AVG_ALLOWABLE ?? row.avg_allowable,
    );
  }
  return avgAllowableByCode;
}

function isUsableOrgForAvg(org: SpecificOrgConfig): boolean {
  if (!isValidContextId(org.contextId)) {
    return false;
  }
  if (!Array.isArray(org.departmentIds) || org.departmentIds.length === 0) {
    return false;
  }
  return org.departmentIds.every(
    (id) => typeof id === "number" && Number.isInteger(id) && id > 0,
  );
}

function emptyAvgMapForCodes(codes: string[]): Record<string, number | null> {
  const empty: Record<string, number | null> = {};
  for (const c of codes) {
    empty[c.toUpperCase()] = null;
  }
  return empty;
}

export async function cptSearchSnowflakeSrt(
  rawCodes: string[],
): Promise<Record<string, CptSrtSlice | null>> {
  const v = validateSearchCodes(rawCodes);
  if (!v.ok) return {};

  const codes = v.codes;
  const placeholders = codes.map(() => "?").join(", ");
  try {
    const sfRows = (await runSnowflakeQuery(
      SF_SRT_QUERY(placeholders),
      codes,
    )) as SfRow[];
    const srtMap = buildSrtMapFromRows(sfRows);
    return srtSliceForCode(codes, srtMap);
  } catch (err) {
    console.error("Snowflake SRT query failed:", err);
    const empty: Record<string, CptSrtSlice | null> = {};
    for (const c of codes) {
      empty[c.toUpperCase()] = null;
    }
    return empty;
  }
}

export async function cptSearchSnowflakeAvg(
  rawCodes: string[],
  org: SpecificOrgConfig,
): Promise<Record<string, number | null>> {
  const v = validateSearchCodes(rawCodes);
  if (!v.ok) return {};

  const codes = v.codes;
  if (!isUsableOrgForAvg(org)) {
    return emptyAvgMapForCodes(codes);
  }

  const placeholders = codes.map(() => "?").join(", ");
  const departmentPlaceholders = org.departmentIds.map(() => "?").join(", ");
  try {
    const avgRows = (await runSnowflakeQuery(
      SF_AVG_QUERY(placeholders, departmentPlaceholders),
      [org.contextId, ...org.departmentIds, ...codes],
    )) as AvgRow[];
    logSnowflakeAvgQueryReturn(avgRows, "cptSearchSnowflakeAvg");
    const avgMap = avgMapFromRows(avgRows);
    const out: Record<string, number | null> = {};
    for (const c of codes) {
      out[c.toUpperCase()] = avgMap[c.toUpperCase()] ?? null;
    }
    return out;
  } catch (err) {
    console.error("Snowflake avg allowable query failed:", err);
    return emptyAvgMapForCodes(codes);
  }
}

async function serperSearchTopUrls(query: string, maxUrls: number): Promise<string[]> {
  const apiKey = getRequiredEnvVar("SERPER_API_KEY");

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({
      q: query,
      num: Math.max(1, Math.min(10, maxUrls)),
    }),
  });

  if (!response.ok) {
    throw new Error(`Serper request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as SerperResponse;
  const urls =
    payload.organic
      ?.map((item) => item.link)
      .filter((link): link is string => Boolean(link && link.trim().length > 0)) ??
    [];

  return urls.slice(0, maxUrls);
}

function sanitizePageText(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return collapsed.slice(0, maxChars).trimEnd();
}

async function evaluateWithAnthropic(args: {
  code: string;
  url: string;
  pageText: string;
}): Promise<"NOT_GOOD_ENOUGH" | string> {
  const apiKey = getRequiredEnvVar("ANTHROPIC_API_KEY");
  const client = new Anthropic({ apiKey });

  const system =
    "You are evaluating whether a webpage contains good, specific information about a particular CPT code. " +
    "If the page is not about the CPT code, is too thin, or looks unrelated, respond with exactly: NOT_GOOD_ENOUGH. " +
    "If it IS good, respond with a concise helpful summary of what the CPT code is/means (2-5 sentences). " +
    "Respond with ONLY either NOT_GOOD_ENOUGH or the summary text. No markdown, no quotes, no extra labels.";

  const user =
    `CPT code: ${args.code}\n` +
    `Source URL: ${args.url}\n\n` +
    "Page text:\n" +
    args.pageText;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    temperature: 0,
    system,
    messages: [{ role: "user", content: user }],
  });

  const firstBlock = message.content?.[0];
  const text = (firstBlock && "text" in firstBlock ? firstBlock.text : "")
    .trim()
    .replace(/\s+/g, " ");

  if (!text) return "NOT_GOOD_ENOUGH";
  if (text === "NOT_GOOD_ENOUGH") return "NOT_GOOD_ENOUGH";
  if (text.toUpperCase() === "NOT_GOOD_ENOUGH") return "NOT_GOOD_ENOUGH";

  return text;
}

async function scrapeSingleCode(
  browser: Browser,
  code: string,
  maxUrlsPerCode: number,
  navTimeoutMs: number,
  maxTextChars: number,
): Promise<CptScrapeSlice> {
  try {
    const query = `CPT code ${code}`;
    const urls = await serperSearchTopUrls(query, maxUrlsPerCode);

    if (urls.length === 0) {
      return {
        code,
        summary: null,
        sourceUrl: null,
        error: "No search results found.",
      };
    }

    let foundSummary: string | null = null;
    let foundUrl: string | null = null;
    let lastError: string | null = null;

    for (const url of urls) {
      const page = await browser.newPage();

      try {
        page.setDefaultNavigationTimeout(navTimeoutMs);

        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: navTimeoutMs,
        });

        const rawText = await page.evaluate(() => {
          return document?.body?.innerText ?? "";
        });

        const pageText = sanitizePageText(rawText, maxTextChars);

        if (pageText.length < 200) {
          lastError = "Page content was too thin.";
          continue;
        }

        const verdict = await evaluateWithAnthropic({ code, url, pageText });

        if (verdict !== "NOT_GOOD_ENOUGH") {
          foundSummary = verdict;
          foundUrl = url;
          break;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Failed to process result.";
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    if (foundSummary) {
      return {
        code,
        summary: foundSummary,
        sourceUrl: foundUrl,
        error: null,
      };
    }
    return {
      code,
      summary: null,
      sourceUrl: null,
      error: lastError ?? "No suitable source found.",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to look up CPT code.";
    return {
      code,
      summary: null,
      sourceUrl: null,
      error: message,
    };
  }
}

export async function cptSearchScrape(rawCodes: string[]): Promise<CptScrapeSlice[]> {
  const v = validateSearchCodes(rawCodes);
  if (!v.ok) {
    return toScrapeSlices(v.results);
  }

  const codes = v.codes;
  const MAX_URLS_PER_CODE = 4;
  const NAV_TIMEOUT_MS = 15_000;
  const MAX_TEXT_CHARS = 20_000;

  let browser: Browser | null = null;
  try {
    browser = await launchPuppeteerBrowser();
    const slices: CptScrapeSlice[] = [];
    for (const code of codes) {
      slices.push(
        await scrapeSingleCode(
          browser,
          code,
          MAX_URLS_PER_CODE,
          NAV_TIMEOUT_MS,
          MAX_TEXT_CHARS,
        ),
      );
    }
    return slices;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function cptSearch(
  rawCodes: string[],
  org?: SpecificOrgConfig,
): Promise<CptSearchResult[]> {
  const v = validateSearchCodes(rawCodes);
  if (!v.ok) {
    return v.results;
  }

  const codes = v.codes;
  const MAX_URLS_PER_CODE = 4;
  const NAV_TIMEOUT_MS = 15_000;
  const MAX_TEXT_CHARS = 20_000;

  let browser: Browser | null = null;

  try {
    browser = await launchPuppeteerBrowser();
    const placeholders = codes.map(() => "?").join(", ");
    const avgOrg = org !== undefined && isUsableOrgForAvg(org) ? org : null;

    const [sfRows, avgRows, scrapeSlices] = await Promise.all([
      runSnowflakeQuery(SF_SRT_QUERY(placeholders), codes).catch((err) => {
        console.error("Snowflake SRT query failed:", err);
        return [] as SfRow[];
      }),
      avgOrg !== null
        ? runSnowflakeQuery(
            SF_AVG_QUERY(
              placeholders,
              avgOrg.departmentIds.map(() => "?").join(", "),
            ),
            [avgOrg.contextId, ...avgOrg.departmentIds, ...codes],
          ).catch((err) => {
            console.error("Snowflake avg allowable query failed:", err);
            return [] as AvgRow[];
          })
        : Promise.resolve([] as AvgRow[]),
      (async () => {
        const slices: CptScrapeSlice[] = [];
        for (const code of codes) {
          slices.push(
            await scrapeSingleCode(
              browser!,
              code,
              MAX_URLS_PER_CODE,
              NAV_TIMEOUT_MS,
              MAX_TEXT_CHARS,
            ),
          );
        }
        return slices;
      })(),
    ]);

    if (avgOrg !== null) {
      logSnowflakeAvgQueryReturn(avgRows, "cptSearch");
    }

    const srtMap = buildSrtMapFromRows(sfRows as SfRow[]);
    const srtByCode = srtSliceForCode(codes, srtMap);
    const avgAllowableByCode = avgMapFromRows(avgRows as AvgRow[]);
    const avgForCodes: Record<string, number | null> = {};
    for (const c of codes) {
      avgForCodes[c.toUpperCase()] = avgAllowableByCode[c.toUpperCase()] ?? null;
    }

    return mergeCptSearchParts(codes, scrapeSlices, srtByCode, avgForCodes);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
