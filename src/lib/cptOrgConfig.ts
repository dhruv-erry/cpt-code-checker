/**
 * Client-supplied Snowflake org context for Specific Org search mode.
 * No defaults are exported or implied — callers must obtain values from the user.
 */
export type SpecificOrgConfig = {
  contextId: number;
  departmentIds: number[];
};

function tokenizeDepartments(input: string): string[] {
  return input
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function isPositiveIntString(s: string): boolean {
  return /^[1-9]\d*$/.test(s);
}

/**
 * Returns null when the input is valid for {@link parseDepartmentsInput};
 * otherwise a short message for inline UI.
 */
export function validateDepartmentsInput(input: string): string | null {
  const tokens = tokenizeDepartments(input);
  if (tokens.length === 0) {
    return "Enter at least one department ID.";
  }
  for (const t of tokens) {
    if (!isPositiveIntString(t)) {
      return `Invalid department ID: "${t}". Use positive whole numbers separated by commas.`;
    }
  }
  return null;
}

/**
 * Trim, split on commas, validate each segment as a finite positive integer, return IDs.
 * Throws if input is invalid (same rules as {@link validateDepartmentsInput}).
 */
export function parseDepartmentsInput(input: string): number[] {
  const err = validateDepartmentsInput(input);
  if (err !== null) {
    throw new Error(err);
  }
  return tokenizeDepartments(input).map((t) => Number(t));
}

export function isValidContextId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
  );
}

/**
 * Returns null when the trimmed field is valid for use as a context ID;
 * otherwise a short message for inline UI.
 */
export function validateContextIdInput(raw: string): string | null {
  const s = raw.trim();
  if (s.length === 0) {
    return "Enter a context ID.";
  }
  if (!isPositiveIntString(s)) {
    return "Context ID must be a positive whole number.";
  }
  return null;
}

/**
 * Parses a context ID string after {@link validateContextIdInput} passes.
 * Throws if the field is invalid.
 */
export function parseContextIdFromInput(raw: string): number {
  const err = validateContextIdInput(raw);
  if (err !== null) {
    throw new Error(err);
  }
  return Number(raw.trim());
}
