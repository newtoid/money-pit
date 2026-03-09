export function nowMs() {
    return Date.now();
}

export function isoTime(ts: number) {
    return new Date(ts).toISOString();
}
