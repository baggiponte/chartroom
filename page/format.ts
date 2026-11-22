export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
export const fmtNum = (v: number): string => (Number.isInteger(v) ? v : Math.round(v * 100) / 100).toLocaleString();
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const esc = (s: string | number): string => String(s).replaceAll(/[&<>"]/g, c => ESCAPES[c] ?? c);
export const cap = (s: string): string => s.replace(/^./, c => c.toUpperCase());
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
