export function parseCsv(raw: string, check?: (ok: unknown, message: string) => void): { headers: string[]; rows: Record<string, string>[] };
