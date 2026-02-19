import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import type { ClobApiCreds } from "./clobCredentials";
import { env } from "./config";

const CLOB_HOST = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = 137;

function readSignatureType() {
    // In signer-as-maker mode, default to EOA signatures unless explicitly overridden.
    if (env.TRADING_USE_SIGNER_AS_MAKER && env.TRADING_SIGNATURE_TYPE === undefined) {
        return 0;
    }

    const parsed = env.TRADING_SIGNATURE_TYPE
        ?? Number(
            process.env.POLYMARKET_SIGNATURE_TYPE?.trim()
            ?? process.env.CLOB_SIGNATURE_TYPE?.trim()
            ?? "0",
        );
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(2, Math.floor(parsed)));
}

function readFunderAddress() {
    if (env.TRADING_USE_SIGNER_AS_MAKER) return undefined;
    return (
        env.TRADING_FUNDER_ADDRESS
        ?? process.env.POLYMARKET_FUNDER_ADDRESS
        ?? process.env.POLYMARKET_FUNDER
        ?? process.env.CLOB_FUNDER
        ?? ""
    ).trim() || undefined;
}

export function createAuthedClobClient(creds: ClobApiCreds | null): ClobClient | null {
    if (!creds) return null;
    const privateKey = process.env.PRIVATE_KEY?.trim();
    if (!privateKey) return null;

    return new ClobClient(
        CLOB_HOST,
        POLYGON_CHAIN_ID,
        new Wallet(privateKey),
        {
            key: creds.apiKey,
            secret: creds.secret,
            passphrase: creds.passphrase,
        } as any,
        readSignatureType() as any,
        readFunderAddress(),
    );
}
