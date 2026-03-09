import { createMarketWs } from "../ws/marketWs";
import { logger } from "../logger";
import { BinaryMarket, TopOfBook } from "./types";
import { BookStateStore } from "./bookState";

type BookTrackerOpts = {
    markets: BinaryMarket[];
    onBookChange?: (tokenId: string, top: TopOfBook) => void;
    onRawMessage?: (message: unknown, ts: number) => void;
};

export class LiveBookTracker {
    private readonly tokenIds: string[];
    private readonly ws: ReturnType<typeof createMarketWs>;
    private readonly store: BookStateStore;

    constructor(private readonly opts: BookTrackerOpts) {
        this.tokenIds = Array.from(
            new Set(opts.markets.flatMap((market) => [market.yesTokenId, market.noTokenId])),
        );
        this.store = new BookStateStore(this.tokenIds);

        this.ws = createMarketWs({
            assetIds: this.tokenIds,
            onMessage: (msg) => this.onMarketMessage(msg),
            onReconnect: () => {
                logger.info({ tokenCount: this.tokenIds.length }, "Arb scanner market feed reconnected");
            },
        });
    }

    start() {
        logger.info({ tokenCount: this.tokenIds.length }, "Starting arb scanner market feed");
        this.ws.start();
    }

    stop() {
        this.ws.stop();
    }

    getTopOfBook(tokenId: string): TopOfBook | null {
        return this.store.getTopOfBook(tokenId);
    }

    private onMarketMessage(message: unknown) {
        const ts = Date.now();
        this.opts.onRawMessage?.(message, ts);
        const updates = this.store.applyMarketMessage(message, ts);
        for (const update of updates) {
            this.opts.onBookChange?.(update.tokenId, update.top);
        }
    }
}
