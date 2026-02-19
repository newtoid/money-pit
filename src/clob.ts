import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { cfg, CHAIN_ID } from "./config.js";
import { log } from "./log.js";

function envCreds() {
    const apiKey = process.env.CLOB_API_KEY;
    const secret = process.env.CLOB_API_SECRET;
    const passphrase = process.env.CLOB_API_PASSPHRASE;
    if (apiKey && secret && passphrase) return { apiKey, secret, passphrase };
    return null;
}

export async function makeAuthedClient() {
    const signer = new Wallet(cfg.PRIVATE_KEY);

    const fromEnv = envCreds();
    if (fromEnv) {
        log.info("Using CLOB API creds from env");
        const client = new ClobClient(cfg.CLOB_HOST, CHAIN_ID, signer, fromEnv as any);
        return { client, apiCreds: fromEnv };
    }

    const tempClient = new ClobClient(cfg.CLOB_HOST, CHAIN_ID, signer);

    let apiCreds: any = null;
    apiCreds = await tempClient.createOrDeriveApiKey();

    const apikey = apiCreds?.apiKey ?? apiCreds?.api_key;
    const secret = apiCreds?.secret;
    const passphrase = apiCreds?.passphrase;

    if (!apikey || !secret || !passphrase) {
        throw new Error("Missing API creds (apikey/secret/passphrase) from createOrDeriveApiKey()");
    }

    log.info("Loaded valid API creds");
    const client = new ClobClient(cfg.CLOB_HOST, CHAIN_ID, signer, apiCreds);
    return { client, apiCreds };
}
