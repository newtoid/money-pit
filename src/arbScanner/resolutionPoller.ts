import { fetchGammaMarketById, normalizeGammaResolutionEvent } from "../adapters/gammaResolution";
import { logger } from "../logger";
import { ArbScannerConfig } from "./config";
import { BinaryMarket, RecordedResolutionEvent } from "./types";

type ResolutionPollerOpts = {
    markets: BinaryMarket[];
    config: ArbScannerConfig;
    onResolutionEvent: (event: RecordedResolutionEvent) => void;
};

export class ResolutionPoller {
    private timer: NodeJS.Timeout | null = null;
    private inFlight = false;
    private readonly finalMarkets = new Set<string>();
    private readonly lastFingerprints = new Map<string, string>();

    constructor(private readonly opts: ResolutionPollerOpts) {}

    start() {
        if (!this.opts.config.resolutionPollingEnabled) return;
        void this.pollOnce();
        this.timer = setInterval(() => {
            void this.pollOnce();
        }, this.opts.config.resolutionPollIntervalMs);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private async pollOnce() {
        if (this.inFlight) return;
        this.inFlight = true;
        const polledAtMs = Date.now();
        const pendingMarkets = this.opts.markets.filter((market) => !this.finalMarkets.has(market.marketId));
        let ingested = 0;
        let trustworthy = 0;
        let untrustworthy = 0;
        const provenanceBreakdown = new Map<string, number>();

        try {
            const results = await Promise.allSettled(
                pendingMarkets.map(async (market) => {
                    const raw = await fetchGammaMarketById(market.marketId, this.opts.config.resolutionRequestTimeoutMs);
                    return {
                        market,
                        event: normalizeGammaResolutionEvent(raw, market, polledAtMs),
                    };
                }),
            );

            for (const result of results) {
                if (result.status === "rejected") {
                    logger.warn({ err: result.reason }, "Resolution polling request failed");
                    continue;
                }
                const { market, event } = result.value;
                if (!event) continue;

                const fingerprint = `${event.resolvedAtMs}:${event.trustworthy}:${event.provenance}:${event.sourceLabel}`;
                if (this.lastFingerprints.get(market.marketId) === fingerprint) continue;

                this.lastFingerprints.set(market.marketId, fingerprint);
                if (event.trustworthy) {
                    this.finalMarkets.add(market.marketId);
                    trustworthy += 1;
                } else {
                    untrustworthy += 1;
                }
                provenanceBreakdown.set(event.provenance, (provenanceBreakdown.get(event.provenance) ?? 0) + 1);
                ingested += 1;
                this.opts.onResolutionEvent(event);
            }

            if (ingested > 0) {
                logger.info(
                    {
                        ingestedResolutionEvents: ingested,
                        trustworthyResolutionEvents: trustworthy,
                        untrustworthyResolutionEvents: untrustworthy,
                        provenanceBreakdown: Object.fromEntries(provenanceBreakdown.entries()),
                    },
                    "Resolution poll cycle ingested settlement events",
                );
            }
        } finally {
            this.inFlight = false;
        }
    }
}
