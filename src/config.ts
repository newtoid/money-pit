// src/config.ts
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ override: true, quiet: true });

function parseEnvBool(value: unknown, defaultValue: boolean) {
    if (value === undefined || value === null || value === "") return defaultValue;

    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;

    if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (["true", "1", "yes", "y", "on"].includes(v)) return true;
        if (["false", "0", "no", "n", "off"].includes(v)) return false;
    }

    // Fallback: behave like JS truthiness if someone sets something weird
    return Boolean(value);
}

const schema = z.object({
    // URLs
    POLYMARKET_USER_WS_URL: z
        .string()
        .default("wss://ws-subscriptions-clob.polymarket.com/ws/user"),
    POLYMARKET_MARKET_WS_URL: z
        .string()
        .default("wss://ws-subscriptions-clob.polymarket.com/ws/market"),

    // Optional auth (required for user channel)
    POLYMARKET_CLOB_API_KEY: z.string().optional(),
    POLYMARKET_CLOB_SECRET: z.string().optional(),
    POLYMARKET_CLOB_PASSPHRASE: z.string().optional(),

    // Your app settings
    CONDITION_ID: z.string().optional(),
    MARKET_SLUG: z.string().optional(),

    DRY_RUN: z.preprocess((v) => parseEnvBool(v, false), z.boolean()),
    TRADING_ENABLED: z.preprocess((v) => parseEnvBool(v, true), z.boolean()),
    TRADING_USE_SIGNER_AS_MAKER: z.preprocess((v) => parseEnvBool(v, false), z.boolean()),
    TRADING_FUNDER_ADDRESS: z.string().optional(),
    TRADING_SIGNATURE_TYPE: z.coerce.number().optional(),
    ALLOW_SHORT_SELL: z.preprocess((v) => parseEnvBool(v, false), z.boolean()),
    MAX_INVENTORY_NOTIONAL_USDC: z.coerce.number().default(20),
    TAKE_PROFIT_ENABLED: z.preprocess((v) => parseEnvBool(v, true), z.boolean()),
    TAKE_PROFIT_PCT: z.coerce.number().default(0.01),

    LOG_LEVEL: z.string().optional(),

    AUTO_CLAIM_ENABLED: z.preprocess((v) => parseEnvBool(v, false), z.boolean()),
    AUTO_CLAIM_INTERVAL_MS: z.coerce.number().default(120000),
    AUTO_CLAIM_MAX_PER_CYCLE: z.coerce.number().default(2),
    POLYGON_RPC_URL: z.string().default("https://polygon-rpc.com"),
    CLAIM_ADDRESS: z.string().optional(),
});

export const env = schema.parse(process.env);
