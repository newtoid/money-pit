import { env } from "../config";
import { logger } from "../logger";
import { ReconnectingWs } from "./ReconnectingWs";

type MarketSubscribeMsg = {
    type: "market";
    assets_ids?: string[];
};

type CreateMarketWsOpts = {
    assetIds: string[];
    onMessage?: (msg: unknown) => void;
    onReconnect?: () => void;
    onOpen?: () => void;
    onClose?: (code: number, reason: string) => void;
};

export function createMarketWs(opts: CreateMarketWsOpts) {
    const { assetIds, onMessage, onReconnect, onOpen, onClose } = opts;
    const ws = new ReconnectingWs({
        url: env.POLYMARKET_MARKET_WS_URL,
        name: "Market",
        onOpen: () => {
            if (onReconnect) onReconnect();
            if (onOpen) onOpen();
            const msg: MarketSubscribeMsg = {
                type: "market",
                assets_ids: assetIds,
            };

            logger.info({ assets: assetIds.length }, "Market WS subscribe");
            ws.sendJson(msg);
        },
        onMessage: (data) => {
            const text = data.toString("utf8");
            try {
                const msg = JSON.parse(text);
                logger.debug({ msg }, "Market WS message");
                onMessage?.(msg);
            } catch {
                logger.debug({ text }, "Market WS message (non-json)");
            }
        },
        onClose: (code, reason) => {
            onClose?.(code, reason.toString("utf8"));
        },
    });

    return ws;
}
