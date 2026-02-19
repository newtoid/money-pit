import type { ClobApiCreds } from "../clobCredentials";
import { env } from "../config";
import { logger } from "../logger";
import { ReconnectingWs } from "./ReconnectingWs";

type UserSubscribeMsg = {
    type: "user";
    auth: { apiKey: string; secret: string; passphrase: string };
    markets: string[];
};

type CreateUserWsOpts = {
    onMessage?: (msg: unknown) => void;
    onReconnect?: () => void;
    onOpen?: () => void;
    onClose?: (code: number, reason: string) => void;
};

function redactCreds(obj: any) {
    const clone = JSON.parse(JSON.stringify(obj));
    if (clone?.secret) clone.secret = "***";
    if (clone?.passphrase) clone.passphrase = "***";
    if (clone?.apiKey) clone.apiKey = "***";
    if (clone?.auth?.secret) clone.auth.secret = "***";
    if (clone?.auth?.passphrase) clone.auth.passphrase = "***";
    if (clone?.auth?.apiKey) clone.auth.apiKey = "***";
    return clone;
}

export function createUserWs(
    marketId: string,
    creds: ClobApiCreds | null,
    opts?: CreateUserWsOpts,
) {
    const { onMessage, onReconnect, onOpen, onClose } = opts ?? {};
    const apiKey = creds?.apiKey;
    const secret = creds?.secret;
    const passphrase = creds?.passphrase;
    const credsPresent = Boolean(apiKey && secret && passphrase);

    const ws = new ReconnectingWs({
        url: env.POLYMARKET_USER_WS_URL,
        name: "User",
        onOpen: async () => {
            if (onReconnect) onReconnect();
            if (onOpen) onOpen();
            logger.info(
                {
                    apiKeyPresent: Boolean(apiKey),
                    secretPresent: Boolean(secret),
                    passphrasePresent: Boolean(passphrase),
                    dryRun: env.DRY_RUN,
                },
                "User WS opening",
            );

            if (env.DRY_RUN || !credsPresent) {
                logger.warn(
                    {
                        dryRun: env.DRY_RUN,
                        apiKeyPresent: Boolean(apiKey),
                        secretPresent: Boolean(secret),
                        passphrasePresent: Boolean(passphrase),
                    },
                    "User WS disabled (missing creds or DRY_RUN=true)",
                );
                return;
            }

            if (!marketId) {
                logger.error("User WS not subscribing: marketId missing");
                return;
            }

            const sub: UserSubscribeMsg = {
                type: "user",
                auth: {
                    apiKey: apiKey!,
                    secret: secret!,
                    passphrase: passphrase!,
                },
                markets: [marketId],
            };

            logger.info({ sub: redactCreds(sub) }, "User WS -> subscribe");
            ws.sendJson(sub);
            logger.info({ marketId }, "User WS subscribed");
        },

        onMessage: (data) => {
            const text = data.toString("utf8");
            try {
                const msg = JSON.parse(text);
                const maybeError = msg?.error ?? msg?.message ?? msg?.msg;
                if (maybeError) {
                    logger.warn({ msg }, "User WS server message");
                } else {
                    logger.debug({ msg }, "User WS message");
                }
                onMessage?.(msg);
            } catch {
                logger.debug({ text }, "User WS message (non-json)");
            }
        },

        onError: (err) => {
            logger.error({ err }, "User WS error");
        },

        onClose: (code, reason) => {
            const reasonStr = reason.toString("utf8");
            logger.warn({ code, reason: reasonStr }, "User WS closed");
            onClose?.(code, reasonStr);
        },
    });

    return ws;
}
