export function normalizeCodes(input: string[]): string[] {
  const out: string[] = [];

  for (const raw of input) {
    const parts = raw
      .split(/[\s,]+/g)
      .map((part) => part.trim())
      .filter(Boolean);

    for (const part of parts) {
      out.push(part.toUpperCase());
    }
  }

  return Array.from(new Set(out));
}

export function isPlausibleCptCode(code: string): boolean {
  if (code.length < 4 || code.length > 8) return false;
  return /^[0-9A-Z]+$/.test(code);
}
