import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { env } from "./config";
import { logger } from "./logger";

const CLOB_HOST = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = 137;

export type ClobApiCreds = {
    apiKey: string;
    secret: string;
    passphrase: string;
};

export type ClobCredsBootstrap = {
    creds: ClobApiCreds;
    source: "env" | "derived";
};

type AuthMode = {
    signatureType: number;
    funderAddress?: string;
};

function readCredFromEnv(primary: string, fallback: string) {
    const p = process.env[primary]?.trim();
    if (p) return p;
    const f = process.env[fallback]?.trim();
    if (f) return f;
    return undefined;
}

function readAuthModeFromEnv(): AuthMode {
    const rawSig =
        process.env.POLYMARKET_SIGNATURE_TYPE?.trim()
        ?? process.env.CLOB_SIGNATURE_TYPE?.trim()
        ?? "0";
    const parsedSig = Number(rawSig);
    const signatureType = Number.isInteger(parsedSig) && parsedSig >= 0 && parsedSig <= 2
        ? parsedSig
        : 0;

    const funderAddress = (
        process.env.POLYMARKET_FUNDER_ADDRESS
        ?? process.env.POLYMARKET_FUNDER
        ?? process.env.CLOB_FUNDER
    )?.trim();

    return {
        signatureType,
        funderAddress: funderAddress || undefined,
    };
}

function trimCreds(
    creds: Partial<ClobApiCreds> | null | undefined,
): ClobApiCreds | null {
    if (!creds) return null;
    const apiKey = creds.apiKey?.trim();
    const secret = creds.secret?.trim();
    const passphrase = creds.passphrase?.trim();
    if (!apiKey || !secret || !passphrase) return null;
    return { apiKey, secret, passphrase };
}

export function readClobApiCredsFromEnv(): ClobApiCreds | null {
    return trimCreds({
        apiKey: readCredFromEnv("POLYMARKET_CLOB_API_KEY", "CLOB_API_KEY")
            ?? env.POLYMARKET_CLOB_API_KEY,
        secret: readCredFromEnv("POLYMARKET_CLOB_SECRET", "CLOB_API_SECRET")
            ?? env.POLYMARKET_CLOB_SECRET,
        passphrase: readCredFromEnv("POLYMARKET_CLOB_PASSPHRASE", "CLOB_API_PASSPHRASE")
            ?? env.POLYMARKET_CLOB_PASSPHRASE,
    });
}

function redactCreds(creds: ClobApiCreds) {
    return {
        apiKey: "***",
        secret: "***",
        passphrase: "***",
        apiKeyLength: creds.apiKey.length,
        secretLength: creds.secret.length,
        passphraseLength: creds.passphrase.length,
    };
}

async function validateApiCreds(
    privateKey: string,
    creds: ClobApiCreds,
    authMode: AuthMode,
): Promise<{ ok: boolean; reason?: string }> {
    try {
        const client = new ClobClient(
            CLOB_HOST,
            POLYGON_CHAIN_ID,
            new Wallet(privateKey),
            {
                key: creds.apiKey,
                secret: creds.secret,
                passphrase: creds.passphrase,
            } as any,
            authMode.signatureType as any,
            authMode.funderAddress,
        );

        const response = await client.getApiKeys();
        const status = (response as any)?.status;
        const error = (response as any)?.error;

        if (status === 401 || status === 403 || error) {
            return {
                ok: false,
                reason: typeof error === "string" ? error : `HTTP ${status ?? "unknown"}`,
            };
        }

        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            reason: err instanceof Error ? err.message : "unknown validation error",
        };
    }
}

async function deriveApiCreds(
    privateKey: string,
    authMode: AuthMode,
): Promise<ClobApiCreds | null> {
    try {
        const client = new ClobClient(
            CLOB_HOST,
            POLYGON_CHAIN_ID,
            new Wallet(privateKey),
            undefined,
            authMode.signatureType as any,
            authMode.funderAddress,
        );

        // Prefer derive first (existing accounts), fallback to create.
        let derived: any;
        try {
            derived = await client.deriveApiKey(0);
        } catch {
            derived = await client.createApiKey(0);
        }
        return trimCreds({
            apiKey: (derived as any)?.apiKey ?? (derived as any)?.api_key ?? (derived as any)?.key,
            secret: (derived as any)?.secret,
            passphrase: (derived as any)?.passphrase,
        });
    } catch (err) {
        logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            "Failed to create/derive API key",
        );
        return null;
    }
}

export async function ensureClobApiCreds(): Promise<ClobCredsBootstrap> {
    const privateKey = process.env.PRIVATE_KEY?.trim();
    if (!privateKey) {
        throw new Error("PRIVATE_KEY is required to validate/regenerate CLOB credentials");
    }

    const authMode = readAuthModeFromEnv();
    logger.info(
        {
            signatureType: authMode.signatureType,
            funderAddress: authMode.funderAddress ?? null,
        },
        "Using CLOB auth mode",
    );

    const envCreds = readClobApiCredsFromEnv();

    if (envCreds) {
        const validation = await validateApiCreds(privateKey, envCreds, authMode);
        if (validation.ok) {
            return { creds: envCreds, source: "env" };
        }
        logger.warn(
            { reason: validation.reason },
            "Env CLOB credentials are invalid; attempting derive from PRIVATE_KEY",
        );
    } else {
        logger.warn("CLOB credentials missing from env; attempting derive from PRIVATE_KEY");
    }

    const derivedCreds = await deriveApiCreds(privateKey, authMode);
    if (!derivedCreds) {
        throw new Error("Unable to derive valid CLOB credentials from PRIVATE_KEY");
    }

    const derivedValidation = await validateApiCreds(privateKey, derivedCreds, authMode);
    if (!derivedValidation.ok) {
        throw new Error(
            `Derived CLOB credentials are invalid: ${derivedValidation.reason ?? "unknown error"}`,
        );
    }

    process.env.POLYMARKET_CLOB_API_KEY = derivedCreds.apiKey;
    process.env.POLYMARKET_CLOB_SECRET = derivedCreds.secret;
    process.env.POLYMARKET_CLOB_PASSPHRASE = derivedCreds.passphrase;
    process.env.CLOB_API_KEY = derivedCreds.apiKey;
    process.env.CLOB_API_SECRET = derivedCreds.secret;
    process.env.CLOB_API_PASSPHRASE = derivedCreds.passphrase;

    logger.info({ creds: redactCreds(derivedCreds) }, "Derived fresh CLOB credentials");
    return { creds: derivedCreds, source: "derived" };
}
