const GAMMA_BASE = "https://gamma-api.polymarket.com";

export async function fetchGammaJson(path: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(`${GAMMA_BASE}${path}`, {
            signal: controller.signal,
            headers: {
                accept: "application/json",
            },
        });
        if (!res.ok) {
            throw new Error(`Gamma request failed: ${res.status} ${res.statusText}`);
        }
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}
