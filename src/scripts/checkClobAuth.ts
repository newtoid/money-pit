import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const CLOB_HOST = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = 137;

type Creds = {
    apiKey: string;
    secret: string;
    passphrase: string;
};

type AuthMode = {
    signatureType: number;
    funderAddress?: string;
};

function readCreds(): Creds | null {
    const apiKey = (process.env.POLYMARKET_CLOB_API_KEY ?? process.env.CLOB_API_KEY)?.trim();
    const secret = (process.env.POLYMARKET_CLOB_SECRET ?? process.env.CLOB_API_SECRET)?.trim();
    const passphrase = (process.env.POLYMARKET_CLOB_PASSPHRASE ?? process.env.CLOB_API_PASSPHRASE)?.trim();
    if (!apiKey || !secret || !passphrase) return null;
    return { apiKey, secret, passphrase };
}

async function validateCreds(privateKey: string, creds: Creds) {
    const authMode = readAuthMode();
    return validateCredsWithMode(privateKey, creds, authMode);
}

function readAuthMode(): AuthMode {
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
    return { signatureType, funderAddress: funderAddress || undefined };
}

async function validateCredsWithMode(privateKey: string, creds: Creds, mode: AuthMode) {
    const signer = new Wallet(privateKey);
    const client = new ClobClient(
        CLOB_HOST,
        POLYGON_CHAIN_ID,
        signer,
        {
            key: creds.apiKey,
            secret: creds.secret,
            passphrase: creds.passphrase,
        } as any,
        mode.signatureType as any,
        mode.funderAddress,
    );
    const res = await client.getApiKeys();
    const status = (res as any)?.status;
    const error = (res as any)?.error;
    return {
        ok: !error && status !== 401 && status !== 403,
        status,
        error,
        wallet: signer.address,
    };
}

async function tryDerive(privateKey: string) {
    const mode = readAuthMode();
    return tryDeriveWithMode(privateKey, mode);
}

async function tryDeriveWithMode(privateKey: string, mode: AuthMode) {
    const signer = new Wallet(privateKey);
    const client = new ClobClient(
        CLOB_HOST,
        POLYGON_CHAIN_ID,
        signer,
        undefined,
        mode.signatureType as any,
        mode.funderAddress,
    );
    let derived: any;
    try {
        derived = await client.deriveApiKey(0);
    } catch {
        derived = await client.createApiKey(0);
    }

    const apiKey = ((derived as any)?.apiKey ?? (derived as any)?.api_key ?? (derived as any)?.key ?? "").trim();
    const secret = ((derived as any)?.secret ?? "").trim();
    const passphrase = ((derived as any)?.passphrase ?? "").trim();
    if (!apiKey || !secret || !passphrase) {
        return { ok: false as const, reason: "derive returned missing fields", wallet: signer.address };
    }
    const check = await validateCredsWithMode(privateKey, { apiKey, secret, passphrase }, mode);
    return {
        ok: check.ok,
        reason: check.ok ? "" : String(check.error ?? check.status ?? "unknown"),
        wallet: signer.address,
        creds: { apiKey, secret, passphrase },
    };
}

function mask(value: string) {
    if (value.length <= 8) return "*".repeat(value.length);
    return `${value.slice(0, 4)}...${value.slice(-4)} (len=${value.length})`;
}

async function main() {
    const privateKey = process.env.PRIVATE_KEY?.trim();
    if (!privateKey) {
        console.error("PRIVATE_KEY missing in .env");
        process.exit(1);
    }

    const creds = readCreds();
    const signer = new Wallet(privateKey);
    const authMode = readAuthMode();
    console.log(`wallet: ${signer.address}`);
    console.log(`signatureType: ${authMode.signatureType}`);
    console.log(`funderAddress: ${authMode.funderAddress ?? "(none)"}`);

    if (!creds) {
        console.log("env creds: missing (POLYMARKET_CLOB_* or CLOB_API_*)");
    } else {
        console.log("env creds:");
        console.log(`  apiKey=${mask(creds.apiKey)}`);
        console.log(`  secret=${mask(creds.secret)}`);
        console.log(`  passphrase=${mask(creds.passphrase)}`);
        const check = await validateCreds(privateKey, creds);
        console.log(`env creds valid: ${check.ok ? "YES" : "NO"}${check.error ? ` (${check.error})` : ""}`);
    }

    const derive = await tryDerive(privateKey);
    console.log(`derive from PRIVATE_KEY: ${derive.ok ? "SUCCESS" : "FAILED"}${derive.reason ? ` (${derive.reason})` : ""}`);

    if (derive.ok && derive.creds) {
        console.log("derived creds (copy to .env):");
        console.log(`POLYMARKET_CLOB_API_KEY=${derive.creds.apiKey}`);
        console.log(`POLYMARKET_CLOB_SECRET=${derive.creds.secret}`);
        console.log(`POLYMARKET_CLOB_PASSPHRASE=${derive.creds.passphrase}`);
    }

    if (!derive.ok) {
        console.log("");
        console.log("mode probe:");
        const candidates: AuthMode[] = [{ signatureType: 0 }];
        if (authMode.funderAddress) {
            candidates.push({ signatureType: 1, funderAddress: authMode.funderAddress });
            candidates.push({ signatureType: 2, funderAddress: authMode.funderAddress });
        } else {
            candidates.push({ signatureType: 1 });
            candidates.push({ signatureType: 2 });
        }

        for (const mode of candidates) {
            try {
                const probe = await tryDeriveWithMode(privateKey, mode);
                console.log(
                    `  sigType=${mode.signatureType} funder=${mode.funderAddress ?? "(none)"} -> ${probe.ok ? "SUCCESS" : "FAILED"}${probe.reason ? ` (${probe.reason})` : ""}`,
                );
            } catch (err) {
                console.log(
                    `  sigType=${mode.signatureType} funder=${mode.funderAddress ?? "(none)"} -> FAILED (${err instanceof Error ? err.message : String(err)})`,
                );
            }
        }
        console.log("If sigType=1 works, set POLYMARKET_SIGNATURE_TYPE=1 and POLYMARKET_FUNDER_ADDRESS=<your profile address>.");
    }
}

main().catch((err) => {
    console.error("check failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
});
