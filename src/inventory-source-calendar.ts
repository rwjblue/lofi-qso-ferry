import { HISTORICAL_TIME_WINDOW_MS } from "./historical-matching.ts";

/** LoFi source and comparison timestamps use the same whole UTC second. */
export function inventorySourceStart(body: unknown): number | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return;
  const raw = (body as Record<string, unknown>).startAtMillis;
  if (typeof raw !== "number" && (typeof raw !== "string" || !raw.trim()))
    return;
  const at = Number(raw);
  if (
    Number.isSafeInteger(at) &&
    at > 0 &&
    Number.isFinite(new Date(at).getTime())
  )
    return Math.floor(at / 1000) * 1000;
}

/** Aggregate read hints, including month boundaries touched by matching. */
export function inventorySourceMonths(body: unknown): string[] {
  const at = inventorySourceStart(body);
  if (at === undefined) return [];
  const months = new Set<string>();
  for (const offset of [
    -HISTORICAL_TIME_WINDOW_MS,
    HISTORICAL_TIME_WINDOW_MS,
  ]) {
    const edge = new Date(at + offset);
    if (!Number.isFinite(edge.getTime())) continue;
    const month = edge.toISOString().slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(month)) months.add(`${month}-01`);
  }
  return [...months];
}
