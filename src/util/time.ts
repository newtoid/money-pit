export function nowMs() {
    return Date.now();
}

export function isoTime(ts: number) {
    return new Date(ts).toISOString();
}

export function parseUtcOffsetToMinutes(offset: string): number {
    const normalized = offset.trim();
    const match = normalized.match(/^([+-])(\d{2}):(\d{2})$/);
    if (!match) return 0;
    const sign = match[1] === "-" ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
    return sign * ((hours * 60) + minutes);
}

export function dayBucketStartMs(ts: number, utcOffsetMinutes: number): number {
    const adjusted = ts + (utcOffsetMinutes * 60_000);
    const dayMs = 86_400_000;
    const bucket = Math.floor(adjusted / dayMs) * dayMs;
    return bucket - (utcOffsetMinutes * 60_000);
}

export function dayBucketEndMs(ts: number, utcOffsetMinutes: number): number {
    return dayBucketStartMs(ts, utcOffsetMinutes) + 86_400_000;
}
