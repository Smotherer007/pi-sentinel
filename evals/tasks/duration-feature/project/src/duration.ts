/** 5400 -> "1h30m", 90 -> "1m30s", 45 -> "45s" */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [h ? `${h}h` : "", m ? `${m}m` : "", s || (!h && !m) ? `${s}s` : ""];
  return parts.join("");
}
