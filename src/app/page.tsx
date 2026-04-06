"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  cptSearchScrape,
  cptSearchSnowflakeAvg,
  cptSearchSnowflakeSrt,
  type CptSearchResult,
  type CptScrapeSlice,
  type CptSrtSlice,
} from "./actions/cptSearch";
import { isValidContextId, type SpecificOrgConfig } from "@/lib/cptOrgConfig";
import { isPlausibleCptCode, normalizeCodes } from "@/lib/cptSearchCodes";
import { mergeCptSearchParts } from "@/lib/cptSearchMerge";
import { SpecificOrgDialog } from "@/components/SpecificOrgDialog";

const CPT_SEARCH_MODE_KEY = "cpt-search-mode";
const CPT_ORG_CONFIG_KEY = "cpt-org-config";
const CPT_SEARCH_HISTORY_KEY = "cpt-search-history";
/** Prior key when history lived in sessionStorage; migrated once on read. */
const CPT_SEARCH_HISTORY_LEGACY_SESSION_KEY = "cpt-search-session-history";
const CPT_SEARCH_HISTORY_MAX = 15;

type CptSavedSearchEntry = {
  id: string;
  codes: string[];
  savedAt: number;
  results: CptSearchResult[];
};

function codesFingerprint(codes: string[]): string {
  return [...codes].map((c) => c.toUpperCase()).sort().join("\0");
}

function isSavedSearchEntry(value: unknown): value is CptSavedSearchEntry {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.savedAt !== "number") return false;
  if (!Array.isArray(row.codes) || !row.codes.every((c) => typeof c === "string")) {
    return false;
  }
  if (!Array.isArray(row.results)) return false;
    return row.results.every((r) => {
    if (!r || typeof r !== "object") return false;
    const item = r as Record<string, unknown>;
    const avgOk =
      item.avgAllowable === undefined ||
      item.avgAllowable === null ||
      (typeof item.avgAllowable === "number" && Number.isFinite(item.avgAllowable));
    return (
      typeof item.code === "string" &&
      (item.summary === null || typeof item.summary === "string") &&
      (item.sourceUrl === null || typeof item.sourceUrl === "string") &&
      (item.error === null || typeof item.error === "string") &&
      avgOk &&
      (item.srt === undefined || item.srt === null || typeof item.srt === "object")
    );
  });
}

function roundAvgTwoDecimals(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseStoredAvgAllowable(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return roundAvgTwoDecimals(value);
  }
  if (typeof value === "string" && Number.isFinite(Number(value))) {
    return roundAvgTwoDecimals(Number(value));
  }
  return null;
}

function normalizeSavedSearchResult(result: CptSearchResult): CptSearchResult {
  const raw = result as Record<string, unknown>;
  const avgAllowable = parseStoredAvgAllowable(raw.avgAllowable);

  if (!result.srt) {
    return { ...result, avgAllowable };
  }

  const normalizedCodes = result.srt.cptCodes
    .map((entry) => {
      if (typeof entry === "string") {
        return { code: entry, avgAllowable: null };
      }

      if (!entry || typeof entry !== "object") {
        return null;
      }

      const row = entry as Record<string, unknown>;
      const code = typeof row.code === "string" ? row.code : null;
      if (!code) {
        return null;
      }

      const nestedAvg =
        typeof row.avgAllowable === "number" && Number.isFinite(row.avgAllowable)
          ? row.avgAllowable
          : typeof row.avgAllowable === "string" && Number.isFinite(Number(row.avgAllowable))
            ? Number(row.avgAllowable)
            : null;
      const avgAllowable =
        nestedAvg === null ? null : roundAvgTwoDecimals(nestedAvg);

      return { code, avgAllowable };
    })
    .filter((entry): entry is { code: string; avgAllowable: number | null } => Boolean(entry));

  const topAvg =
    avgAllowable ??
    normalizedCodes.find((e) => e.code.toUpperCase() === result.code.toUpperCase())
      ?.avgAllowable ??
    null;

  return {
    ...result,
    avgAllowable: topAvg,
    srt: {
      ...result.srt,
      cptCodes: normalizedCodes,
    },
  };
}

function normalizeSavedSearchEntry(entry: CptSavedSearchEntry): CptSavedSearchEntry {
  return {
    ...entry,
    results: entry.results.map(normalizeSavedSearchResult),
  };
}

function readSavedSearchHistory(): CptSavedSearchEntry[] {
  if (typeof window === "undefined") return [];
  try {
    let raw = localStorage.getItem(CPT_SEARCH_HISTORY_KEY);
    if (!raw) {
      raw = sessionStorage.getItem(CPT_SEARCH_HISTORY_LEGACY_SESSION_KEY);
      if (raw) {
        try {
          localStorage.setItem(CPT_SEARCH_HISTORY_KEY, raw);
        } catch {
          /* ignore migration if localStorage is full or unavailable */
        }
        try {
          sessionStorage.removeItem(CPT_SEARCH_HISTORY_LEGACY_SESSION_KEY);
        } catch {
          /* ignore */
        }
      }
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedSearchEntry).map(normalizeSavedSearchEntry);
  } catch {
    return [];
  }
}

function writeSavedSearchHistory(
  entries: CptSavedSearchEntry[],
): CptSavedSearchEntry[] {
  if (typeof window === "undefined") return entries;
  let toSave = entries;
  while (toSave.length > 0) {
    try {
      localStorage.setItem(CPT_SEARCH_HISTORY_KEY, JSON.stringify(toSave));
      return toSave;
    } catch {
      toSave = toSave.slice(0, Math.ceil(toSave.length / 2));
    }
  }
  try {
    localStorage.removeItem(CPT_SEARCH_HISTORY_KEY);
  } catch {
    /* ignore */
  }
  return [];
}

type ParallelSearchProgress = {
  codes: string[];
  scrape: CptScrapeSlice[] | null;
  srt: Record<string, CptSrtSlice | null> | null;
  avg: Record<string, number | null> | null;
};

type SearchState = {
  loading: boolean;
  error: string | null;
  data: CptSearchResult[] | null;
  parallel: ParallelSearchProgress | null;
};

function parseCodesInput(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  return trimmed
    .split(/[\n,]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatHelperCount(count: number): string {
  if (count <= 0) return "No codes detected yet.";
  if (count === 1) return "1 code detected.";
  return `${count} codes detected.`;
}

const avgAllowableFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatAvgAllowable(value: number | null, avgPending: boolean): string {
  if (avgPending) return "Avg allowable: Loading…";
  return value == null ? "Avg allowable: N/A" : `Avg allowable: ${avgAllowableFormatter.format(value)}`;
}

function emptySrtMap(codes: string[]): Record<string, CptSrtSlice | null> {
  const out: Record<string, CptSrtSlice | null> = {};
  for (const c of codes) {
    out[c.toUpperCase()] = null;
  }
  return out;
}

function emptyAvgMap(codes: string[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const c of codes) {
    out[c.toUpperCase()] = null;
  }
  return out;
}

type CptSearchMode = "general" | "specificOrg";

function readSearchModeFromStorage(): CptSearchMode {
  if (typeof window === "undefined") return "general";
  return localStorage.getItem(CPT_SEARCH_MODE_KEY) === "specificOrg"
    ? "specificOrg"
    : "general";
}

function parseStoredOrgConfig(raw: string | null): SpecificOrgConfig | null {
  if (!raw?.trim()) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const contextId = o.contextId;
    const departmentIds = o.departmentIds;
    if (!isValidContextId(contextId)) return null;
    if (!Array.isArray(departmentIds) || departmentIds.length === 0) return null;
    if (
      !departmentIds.every(
        (id) => typeof id === "number" && Number.isInteger(id) && id > 0,
      )
    ) {
      return null;
    }
    return { contextId, departmentIds: departmentIds as number[] };
  } catch {
    return null;
  }
}

/**
 * Reads mode + org from storage; if mode is Specific Org without a valid org payload,
 * coerces to General and aligns localStorage (no SO without explicit org).
 */
function hydrateSearchModeAndOrgFromStorage(): {
  searchMode: CptSearchMode;
  orgConfig: SpecificOrgConfig | null;
} {
  if (typeof window === "undefined") {
    return { searchMode: "general", orgConfig: null };
  }
  const mode = readSearchModeFromStorage();
  const org = parseStoredOrgConfig(localStorage.getItem(CPT_ORG_CONFIG_KEY));
  if (mode === "specificOrg" && !org) {
    try {
      localStorage.setItem(CPT_SEARCH_MODE_KEY, "general");
      localStorage.removeItem(CPT_ORG_CONFIG_KEY);
    } catch {
      /* ignore */
    }
    return { searchMode: "general", orgConfig: null };
  }
  return { searchMode: mode, orgConfig: org };
}

export default function CptHomePage() {
  const [rawCodes, setRawCodes] = useState("");
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [savedSearchHistory, setSavedSearchHistory] = useState<CptSavedSearchEntry[]>([]);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [copyAllFeedback, setCopyAllFeedback] = useState<string | null>(null);
  const [copyAllWithPriceFeedback, setCopyAllWithPriceFeedback] = useState<string | null>(null);
  const [searchState, setSearchState] = useState<SearchState>({
    loading: false,
    error: null,
    data: null,
    parallel: null,
  });
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [mounted, setMounted] = useState(false);
  const [searchMode, setSearchMode] = useState<CptSearchMode>("general");
  const [orgConfig, setOrgConfig] = useState<SpecificOrgConfig | null>(null);
  const [orgDialogOpen, setOrgDialogOpen] = useState(false);
  const [orgDialogReason, setOrgDialogReason] = useState<"required" | "change" | null>(null);

  const savedHistoryListRef = useRef<HTMLUListElement>(null);
  const [historyListFlushTop, setHistoryListFlushTop] = useState(false);
  const [historyListFlushBottom, setHistoryListFlushBottom] = useState(false);

  const syncSavedHistoryListScrollEdges = useCallback(() => {
    const el = savedHistoryListRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const epsilon = 2;
    const canScroll = scrollHeight > clientHeight + epsilon;
    if (!canScroll) {
      setHistoryListFlushTop(false);
      setHistoryListFlushBottom(false);
      return;
    }
    setHistoryListFlushTop(scrollTop <= epsilon);
    setHistoryListFlushBottom(scrollTop + clientHeight >= scrollHeight - epsilon);
  }, []);

  useLayoutEffect(() => {
    const el = savedHistoryListRef.current;
    if (!el || savedSearchHistory.length === 0) return;
    syncSavedHistoryListScrollEdges();
    el.addEventListener("scroll", syncSavedHistoryListScrollEdges, { passive: true });
    const ro = new ResizeObserver(() => syncSavedHistoryListScrollEdges());
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", syncSavedHistoryListScrollEdges);
      ro.disconnect();
    };
  }, [savedSearchHistory.length, syncSavedHistoryListScrollEdges]);

  useEffect(() => {
    const { searchMode: nextMode, orgConfig: nextOrg } = hydrateSearchModeAndOrgFromStorage();
    setSearchMode(nextMode);
    setOrgConfig(nextOrg);
    setMounted(true);
    setSavedSearchHistory(readSavedSearchHistory());
    const savedTheme = localStorage.getItem("cpt-theme") as "dark" | "light" | null;
    if (savedTheme) {
      setTheme(savedTheme);
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    try {
      localStorage.setItem(CPT_SEARCH_MODE_KEY, searchMode);
    } catch {
      /* ignore */
    }
  }, [searchMode, mounted]);

  useEffect(() => {
    if (!mounted) return;
    try {
      if (orgConfig) {
        localStorage.setItem(CPT_ORG_CONFIG_KEY, JSON.stringify(orgConfig));
      } else {
        localStorage.removeItem(CPT_ORG_CONFIG_KEY);
      }
    } catch {
      /* ignore */
    }
  }, [orgConfig, mounted]);

  useEffect(() => {
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(`theme-${theme}`);
    if (mounted) {
      localStorage.setItem("cpt-theme", theme);
    }
  }, [theme, mounted]);

  const parsedCodes = useMemo(() => parseCodesInput(rawCodes), [rawCodes]);
  const results = useMemo(() => {
    if (searchState.parallel) {
      const p = searchState.parallel;
      return mergeCptSearchParts(p.codes, p.scrape, p.srt, p.avg);
    }
    return searchState.data ?? [];
  }, [searchState.parallel, searchState.data]);

  const hasSubmitted =
    searchState.data !== null ||
    searchState.parallel !== null ||
    searchState.error !== null;

  const selectedResult =
    (selectedCode ? results.find((result) => result.code === selectedCode) : null) ?? null;
  const selectedAvgAllowable =
    selectedResult?.avgAllowable ??
    selectedResult?.srt?.cptCodes.find((entry) => entry.code === selectedResult.code)
      ?.avgAllowable ??
    null;
  const showOrgExtras = searchMode === "specificOrg" && orgConfig !== null;
  const showAvgAllowableBadge =
    showOrgExtras && Boolean(selectedResult?.srt);
  const avgPending = Boolean(
    showOrgExtras && searchState.parallel && searchState.parallel.avg === null,
  );
  const scrapePending = Boolean(searchState.parallel && searchState.parallel.scrape === null);
  const srtPending = Boolean(searchState.parallel && searchState.parallel.srt === null);
  /** Shrink output card when there are no results yet, or selected code has no SRT block. */
  const detailsOutputCompact =
    results.length === 0 ||
    (results.length > 0 && selectedResult !== null && !selectedResult.srt);
  const hasAnySummary = results.some((r) => Boolean(r.summary));
  const allSummariesLoaded =
    showOrgExtras && !scrapePending && hasAnySummary;
  const allPricesLoaded =
    showOrgExtras && !scrapePending && !avgPending && hasAnySummary;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const codes = parsedCodes;
    if (codes.length === 0) {
      setSearchState({
        loading: false,
        error: "Paste one or more CPT codes to search.",
        data: null,
        parallel: null,
      });
      return;
    }

    const normalized = normalizeCodes(codes);
    const invalid = normalized.filter((c) => !isPlausibleCptCode(c));
    if (invalid.length > 0) {
      const rows: CptSearchResult[] = invalid.map((code) => ({
        code,
        summary: null,
        sourceUrl: null,
        error: "Invalid CPT code format.",
        avgAllowable: null,
        srt: null,
      }));
      setSearchState({
        loading: false,
        error: null,
        data: rows,
        parallel: null,
      });
      setSelectedCode(rows[0]?.code ?? null);
      const fp = codesFingerprint(invalid);
      const newEntry: CptSavedSearchEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        codes: invalid,
        savedAt: Date.now(),
        results: rows,
      };
      setSavedSearchHistory((prev) => {
        let next: CptSavedSearchEntry[];
        if (prev[0] && codesFingerprint(prev[0].codes) === fp) {
          next = [{ ...newEntry, id: prev[0].id }, ...prev.slice(1)];
        } else {
          next = [newEntry, ...prev].slice(0, CPT_SEARCH_HISTORY_MAX);
        }
        return writeSavedSearchHistory(next);
      });
      return;
    }

    const orgForAvg =
      searchMode === "specificOrg" && orgConfig !== null ? orgConfig : null;

    setSearchState({
      loading: true,
      error: null,
      data: null,
      parallel: {
        codes: normalized,
        scrape: null,
        srt: null,
        avg: orgForAvg ? null : emptyAvgMap(normalized),
      },
    });
    setSelectedCode(normalized[0] ?? null);

    try {
      await Promise.allSettled([
        cptSearchScrape(normalized)
          .then((rows) => {
            setSearchState((prev) =>
              prev.parallel
                ? { ...prev, parallel: { ...prev.parallel, scrape: rows } }
                : prev,
            );
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : "Scrape failed.";
            const fallback: CptScrapeSlice[] = normalized.map((code) => ({
              code,
              summary: null,
              sourceUrl: null,
              error: msg,
            }));
            setSearchState((prev) =>
              prev.parallel
                ? { ...prev, parallel: { ...prev.parallel, scrape: fallback } }
                : prev,
            );
          }),
        cptSearchSnowflakeSrt(normalized)
          .then((srt) => {
            setSearchState((prev) =>
              prev.parallel
                ? { ...prev, parallel: { ...prev.parallel, srt } }
                : prev,
            );
          })
          .catch(() => {
            setSearchState((prev) =>
              prev.parallel
                ? { ...prev, parallel: { ...prev.parallel, srt: emptySrtMap(normalized) } }
                : prev,
            );
          }),
        ...(orgForAvg
          ? [
              cptSearchSnowflakeAvg(normalized, orgForAvg)
                .then((avg) => {
                  setSearchState((prev) =>
                    prev.parallel
                      ? { ...prev, parallel: { ...prev.parallel, avg } }
                      : prev,
                  );
                })
                .catch(() => {
                  setSearchState((prev) =>
                    prev.parallel
                      ? {
                          ...prev,
                          parallel: {
                            ...prev.parallel,
                            avg: emptyAvgMap(normalized),
                          },
                        }
                      : prev,
                  );
                }),
            ]
          : []),
      ]);

      setSearchState((prev) => {
        if (!prev.parallel) {
          return { ...prev, loading: false };
        }
        const { codes: cList, scrape, srt, avg } = prev.parallel;
        const merged = mergeCptSearchParts(cList, scrape, srt, avg);
        const fp = codesFingerprint(cList);
        const newEntry: CptSavedSearchEntry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          codes: cList,
          savedAt: Date.now(),
          results: merged,
        };
        queueMicrotask(() => {
          setSavedSearchHistory((prevHist) => {
            let next: CptSavedSearchEntry[];
            if (prevHist[0] && codesFingerprint(prevHist[0].codes) === fp) {
              next = [{ ...newEntry, id: prevHist[0].id }, ...prevHist.slice(1)];
            } else {
              next = [newEntry, ...prevHist].slice(0, CPT_SEARCH_HISTORY_MAX);
            }
            return writeSavedSearchHistory(next);
          });
          const firstUsable = merged.find((item) => item.summary) ?? merged[0] ?? null;
          setSelectedCode(firstUsable?.code ?? null);
        });

        return {
          loading: false,
          error: null,
          data: merged,
          parallel: null,
        };
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Search failed. Please try again.";
      setSearchState({
        loading: false,
        error: message,
        data: null,
        parallel: null,
      });
    }
  }

  function restoreSavedEntry(entry: CptSavedSearchEntry) {
    setRawCodes(entry.codes.join(", "));
    setSearchState({ loading: false, error: null, data: entry.results, parallel: null });
    const firstUsable =
      entry.results.find((item) => item.summary) ?? entry.results[0] ?? null;
    setSelectedCode(firstUsable?.code ?? null);
  }

  function deleteSavedSearchEntry(id: string, event: React.MouseEvent) {
    event.stopPropagation();
    setSavedSearchHistory((prev) => {
      const next = prev.filter((entry) => entry.id !== id);
      return writeSavedSearchHistory(next);
    });
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopyFeedback("Copied!");
      setTimeout(() => setCopyFeedback(null), 2000);
    });
  }

  function copyAllDescriptions() {
    const summaries = results
      .map((r) => r.summary)
      .filter((summary): summary is string => typeof summary === "string" && summary.length > 0);
    if (summaries.length === 0) return;

    const allText = summaries.join("\n\n");
    navigator.clipboard.writeText(allText).then(() => {
      setCopyAllFeedback("Copied!");
      setTimeout(() => setCopyAllFeedback(null), 2000);
    });
  }

  function copyAllDescriptionsWithPrices() {
    const entries = results
      .map((result) => {
        const summary =
          typeof result.summary === "string" && result.summary.length > 0 ? result.summary : null;
        const avgAllowable =
          result.avgAllowable ??
          result.srt?.cptCodes.find((entry) => entry.code.toUpperCase() === result.code.toUpperCase())
            ?.avgAllowable ??
          null;

        if (!summary && avgAllowable == null) return null;

        const lines = [`${result.code}${avgAllowable == null ? "" : ` - Avg allowable: ${avgAllowableFormatter.format(avgAllowable)}`}`];
        if (summary) {
          lines.push(summary);
        }
        return lines.join("\n");
      })
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

    if (entries.length === 0) return;

    navigator.clipboard.writeText(entries.join("\n\n")).then(() => {
      setCopyAllWithPriceFeedback("Copied!");
      setTimeout(() => setCopyAllWithPriceFeedback(null), 2000);
    });
  }

  function handleTabsWheel(event: React.WheelEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const { deltaY, deltaX } = event;

    // Disable vertical wheel scrolling while cursor is over the tabs pane.
    // We always translate wheel movement into horizontal scrolling.
    event.preventDefault();
    event.stopPropagation();
    el.scrollLeft += deltaX + deltaY;
  }

  function clearSavedSearchHistory() {
    setSavedSearchHistory([]);
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(CPT_SEARCH_HISTORY_KEY);
      } catch {
        /* ignore */
      }
      try {
        sessionStorage.removeItem(CPT_SEARCH_HISTORY_LEGACY_SESSION_KEY);
      } catch {
        /* ignore */
      }
    }
  }

  function openOrgDialogChange() {
    setOrgDialogReason("change");
    setOrgDialogOpen(true);
  }

  function handleOrgDialogConfirm(next: SpecificOrgConfig) {
    setOrgConfig(next);
    setSearchMode("specificOrg");
    setOrgDialogOpen(false);
    setOrgDialogReason(null);
  }

  function handleOrgDialogCancel() {
    setOrgDialogOpen(false);
    if (orgDialogReason === "required") {
      setSearchMode("general");
    }
    setOrgDialogReason(null);
  }

  const orgDialogInitialContext =
    orgDialogReason === "change" && orgConfig ? String(orgConfig.contextId) : "";
  const orgDialogInitialDepartments =
    orgDialogReason === "change" && orgConfig ? orgConfig.departmentIds.join(", ") : "";

  return (
    <main className="page-root cpt-page">
      <header className="page-header">
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title">CPT Code Search</h1>
          <p className="page-subtitle">Paste one or more CPT codes and get a short, source-backed explanation for each.</p>
        </div>
        {mounted ? (
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", alignItems: "center" }}>
              <label className="cpt-search-mode-label" style={{ display: "flex", alignItems: "center", gap: "8px", margin: 0 }}>
                <select
                  id="cpt-search-mode"
                  className="cpt-search-mode-select"
                  value={searchMode}
                  onChange={(e) => {
                    const v = e.target.value as CptSearchMode;
                    if (v === "general") {
                      setSearchMode("general");
                      setOrgDialogOpen(false);
                      setOrgDialogReason(null);
                      return;
                    }
                    if (orgConfig) {
                      setSearchMode("specificOrg");
                      return;
                    }
                    setOrgDialogReason("required");
                    setOrgDialogOpen(true);
                  }}
                  aria-label="Search mode"
                >
                  <option value="general">General</option>
                  <option value="specificOrg">Specific Org</option>
                </select>
              </label>

              {searchMode === "specificOrg" ? (
                <button
                  type="button"
                  className="secondary-button cpt-contextid-button"
                  onClick={openOrgDialogChange}
                  aria-label="Change org context"
                  style={{ padding: "0.2rem 0.7rem", lineHeight: 1 }}
                >
                  Context ID: {orgConfig ? `${orgConfig.contextId}` : "[]"}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              className="secondary-button cpt-theme-toggle"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? (
                "☀ Light Mode"
              ) : (
                <>
                  <svg
                    className="cpt-theme-toggle__moon"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    width={18}
                    height={18}
                    aria-hidden
                  >
                    <path
                      fill="currentColor"
                      d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446A9 9 0 1 1 12 3z"
                    />
                  </svg>
                  <span>Dark Mode</span>
                </>
              )}
            </button>
          </div>
        ) : null}
      </header>

      <section className="page-layout">
        <section className="search-column">
          <form className="search-card" onSubmit={handleSubmit}>
            <div className="card-header">
              <span className="card-title">Input</span>
            </div>
            <textarea
              id="cpt-codes"
              className="text-input"
              placeholder={"One per line or comma-separated (e.g. 99213, 93000)\n99213\n93000"}
              value={rawCodes}
              onChange={(event) => setRawCodes(event.target.value)}
              rows={6}
              spellCheck={false}
            />
            <div className="search-row">
              <button
                type="submit"
                className="primary-button"
                disabled={searchState.loading}
              >
                {searchState.loading ? "Searching…" : "Search"}
              </button>
              <span className="helper-text">{formatHelperCount(parsedCodes.length)}</span>
            </div>
            {searchState.error ? <p className="error-text">{searchState.error}</p> : null}
          </form>

          {savedSearchHistory.length > 0 ? (
            <div className="results-card cpt-saved-history">
              <div className="card-header" style={{ justifyContent: "space-between" }}>
                <span className="card-title">History</span>
                <button
                  type="button"
                  className="cpt-saved-history__clear"
                  onClick={clearSavedSearchHistory}
                >
                  Clear
                </button>
              </div>
              <ul
                ref={savedHistoryListRef}
                className={[
                  "cpt-saved-history__list",
                  historyListFlushTop ? "cpt-saved-history__list--flush-top" : "",
                  historyListFlushBottom ? "cpt-saved-history__list--flush-bottom" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {savedSearchHistory.map((entry) => {
                  const fullCodes = entry.codes.join(", ");
                  const label =
                    entry.codes.length === 1
                      ? entry.codes[0]
                      : entry.codes.length <= 3
                        ? fullCodes
                        : `${entry.codes.slice(0, 3).join(", ")}… (+${entry.codes.length - 3})`;
                  const timeLabel = new Date(entry.savedAt).toLocaleString(undefined, {
                    dateStyle: "short",
                    timeStyle: "short",
                  });
                  const okCount = entry.results.filter((r) => r.summary).length;

                  return (
                    <li key={entry.id} className="cpt-saved-history__item">
                      <button
                        type="button"
                        className="cpt-saved-history__row"
                        title={fullCodes}
                        onClick={() => restoreSavedEntry(entry)}
                      >
                        <span className="cpt-saved-history__codes">{label}</span>
                        <span className="cpt-saved-history__meta">
                          {timeLabel}
                          {entry.results.length > 0 && okCount !== entry.results.length ? (
                            <>
                              {" · "}
                              {okCount === entry.results.length
                                ? `${okCount} found`
                                : `${okCount}/${entry.results.length} found`}
                            </>
                          ) : null}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="cpt-saved-history__delete"
                        title="Delete history entry"
                        onClick={(e) => deleteSavedSearchEntry(entry.id, e)}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </section>

        <section
          className={
            detailsOutputCompact
              ? "details-column details-column--output-compact"
              : "details-column"
          }
        >
          <div
            className={
              detailsOutputCompact ? "details-card details-card--output-compact" : "details-card"
            }
          >
            {results.length === 0 && searchState.loading ? (
              <>
                <div className="card-header">
                  <span className="card-title">Output</span>
                </div>
                <div className="placeholder-panel">
                  <p className="placeholder-title">Looking up codes…</p>
                </div>
              </>
            ) : results.length === 0 ? (
              <>
                <div className="card-header">
                  <span className="card-title">Output</span>
                </div>
                <div className="placeholder-panel">
                  <p className="placeholder-title">
                    {hasSubmitted ? "No results found." : "No code selected yet"}
                  </p>
                  <p className="placeholder-body">
                    {hasSubmitted
                      ? "Try searching for a valid CPT code."
                      : "Enter CPT codes on the left and hit Search."}
                  </p>
                </div>
              </>
            ) : (
              <>
                {/* Tab strip in card header */}
                <div className="card-header">
                  {results.length > 1 ? (
                    <div
                      className="cpt-tabs"
                      onWheelCapture={(event) => handleTabsWheel(event)}
                    >
                      {results.map((result) => (
                        <button
                          key={result.code}
                          type="button"
                          className={`cpt-tab${result.code === selectedCode ? " cpt-tab--active" : ""}${result.error && !result.summary ? " cpt-tab--error" : ""}`}
                          onClick={() => setSelectedCode(result.code)}
                        >
                          {result.code}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="card-title">Output</span>
                  )}
                </div>

                {/* Tab content */}
                {selectedResult ? (
                  <div className="cpt-tab-panel">
                    <div
                      className="details-header"
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        justifyContent: "space-between",
                        gap: "16px",
                        flexWrap: "wrap",
                      }}
                    >
                      <div className="details-title-block">
                        <h2 className="details-title" style={{ margin: 0 }}>
                          {selectedResult.code}
                        </h2>
                      </div>
                      {showAvgAllowableBadge ? (
                        <div
                          style={{
                            padding: "8px 12px",
                            borderRadius: "999px",
                            background:
                              theme === "dark"
                                ? "rgba(255, 255, 255, 0.08)"
                                : "rgba(15, 23, 42, 0.05)",
                            border:
                              theme === "dark"
                                ? "1px solid rgba(255, 255, 255, 0.12)"
                                : "1px solid rgba(15, 23, 42, 0.08)",
                            color: theme === "dark" ? "rgba(255, 255, 255, 0.86)" : "#334155",
                            fontSize: "0.9rem",
                            fontWeight: "600",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {formatAvgAllowable(selectedAvgAllowable, avgPending)}
                        </div>
                      ) : null}
                    </div>

                    {selectedResult.error ? (
                      <p className="error-text">{selectedResult.error}</p>
                    ) : null}

                    {scrapePending ? (
                      <p className="placeholder-text">Fetching description from sources…</p>
                    ) : selectedResult.summary ? (
                      <p className="summary-box">{selectedResult.summary}</p>
                    ) : (
                      <p className="placeholder-text">
                        No usable summary was found for this code from the evaluated sources.
                      </p>
                    )}

                    <div className="button-stack">
                      <div className="button-group">
                        <a
                          href={`https://www.google.com/search?q=CPT+code+${selectedResult.code}+description`}
                          target="_blank"
                          rel="noreferrer"
                          className="link-button"
                        >
                          Open Google Search
                        </a>
                        {selectedResult.sourceUrl ? (
                          <a
                            href={selectedResult.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="link-button"
                          >
                            Open Source
                          </a>
                        ) : null}
                      </div>
                      {showOrgExtras ? (
                        <div className="button-group">
                          {selectedResult.summary ? (
                            <button
                              type="button"
                              className="secondary-button copy-button"
                              onClick={() => copyToClipboard(selectedResult.summary!)}
                            >
                              {copyFeedback === "Copied!" ? "✓ Copied" : "Copy Description"}
                            </button>
                          ) : null}
                          {allSummariesLoaded ? (
                            <button
                              type="button"
                              className="secondary-button copy-button"
                              onClick={copyAllDescriptions}
                            >
                              {copyAllFeedback === "Copied!" ? "✓ Copied" : "Copy all"}
                            </button>
                          ) : null}
                          {allPricesLoaded ? (
                            <button
                              type="button"
                              className="secondary-button copy-button"
                              onClick={copyAllDescriptionsWithPrices}
                            >
                              {copyAllWithPriceFeedback === "Copied!"
                                ? "✓ Copied"
                                : "Copy all with price"}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    {srtPending ? (
                      <p className="placeholder-text" style={{ marginTop: "20px" }}>
                        Loading SRT data from Snowflake…
                      </p>
                    ) : selectedResult.srt ? (
                      <div className="srt-section">
                        <h3 className="srt-section__title">Existing SRT Information</h3>
                        <dl className="srt-section__fields">
                          <div className="srt-section__name-id-row">
                            <div className="srt-field srt-field--id">
                              <dt className="srt-field__label">ID</dt>
                              <dd className="srt-field__value srt-field__value--primary">
                                {selectedResult.srt.id}
                              </dd>
                            </div>
                            <div className="srt-field">
                              <dt className="srt-field__label">Name</dt>
                              <dd className="srt-field__value srt-field__value--primary">
                                {selectedResult.srt.name}
                              </dd>
                            </div>
                          </div>
                        </dl>
                        <h4 className="srt-section__codes-heading">CPT codes in this SRT</h4>
                        <ul className="srt-codes">
                          {selectedResult.srt.cptCodes.map(({ code }) => (
                            <li
                              key={code}
                              className={
                                code === selectedResult.code ? "srt-codes__item--current" : undefined
                              }
                            >
                              {code}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>
      </section>

      <SpecificOrgDialog
        open={orgDialogOpen}
        initialContextId={orgDialogInitialContext}
        initialDepartments={orgDialogInitialDepartments}
        onConfirm={handleOrgDialogConfirm}
        onCancel={handleOrgDialogCancel}
      />
    </main>
  );
}
