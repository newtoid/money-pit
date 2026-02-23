import { ethers, Wallet } from "ethers";
import { logger } from "./logger";

const DATA_API = "https://data-api.polymarket.com";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_ABI = [
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];

type PositionRow = {
    conditionId?: string;
    size?: string | number;
    redeemable?: boolean;
};

type RedeemablesSnapshot = {
    enabled: boolean;
    addresses: string[];
    claimAddress: string | null;
    configuredSignerAddress: string | null;
    redeemSignerAddress: string | null;
    redeemReady: boolean;
    redeemDisabledReason: string | null;
    totalRedeemables: number;
    byAddress: Array<{ address: string; redeemables: number }>;
    lastScanAt: number | null;
    lastRedeemAt: number | null;
    lastRedeemTxHash: string | null;
    inFlight: boolean;
    cycles: number;
    redeemedCount: number;
    lastError: string | null;
    rpcUrls: string[];
    activeRpcUrl: string | null;
    history: Array<{
        at: number;
        ok: boolean;
        redeemed: number;
        txHash: string | null;
        error: string | null;
    }>;
};

function parseSize(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function normalizeConditionId(id: string): string | null {
    const s = id?.trim?.();
    if (!s) return null;
    if (s.startsWith("0x") && s.length === 66) return s;
    if (!s.startsWith("0x") && s.length === 64) return `0x${s}`;
    return null;
}

function normalizeAddress(addr: string | null | undefined): string | null {
    const s = addr?.trim?.();
    if (!s) return null;
    return s.toLowerCase();
}

function addressFromPrivateKey(pk: string | null): string | null {
    if (!pk) return null;
    try {
        return new Wallet(pk).address;
    } catch {
        return null;
    }
}

function parseAddressList(raw: string | undefined, fallback: string[]): string[] {
    if (!raw) return fallback;
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return Array.from(new Set(list));
}

function parseRpcUrls(): string[] {
    const listRaw = process.env.POLYGON_RPC_URLS?.trim();
    const singleRaw = process.env.POLYGON_RPC_URL?.trim();
    const fromList = listRaw
        ? listRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    const fromSingle = singleRaw ? [singleRaw] : [];
    const merged = Array.from(new Set([...fromList, ...fromSingle]));
    if (merged.length > 0) return merged;
    return ["https://polygon-bor-rpc.publicnode.com"];
}

function isRetryableRpcError(err: unknown): boolean {
    const e = err as any;
    const code = String(e?.code ?? "");
    const msg = String(e?.message ?? e ?? "").toLowerCase();
    if (code === "NETWORK_ERROR" || code === "SERVER_ERROR" || code === "TIMEOUT") return true;
    return (
        msg.includes("no network")
        || msg.includes("bad response")
        || msg.includes("timeout")
        || msg.includes("econnreset")
        || msg.includes("etimedout")
    );
}

async function fetchRedeemableConditions(user: string): Promise<string[]> {
    const res = await fetch(`${DATA_API}/positions?user=${encodeURIComponent(user)}&sizeThreshold=0`);
    if (!res.ok) throw new Error(`positions HTTP ${res.status}`);
    const rows = (await res.json()) as PositionRow[];
    if (!Array.isArray(rows)) return [];
    const out = new Set<string>();
    for (const r of rows) {
        if (!r?.redeemable) continue;
        if (parseSize(r.size) <= 0) continue;
        const cid = normalizeConditionId(String(r.conditionId ?? ""));
        if (cid) out.add(cid);
    }
    return Array.from(out);
}

export class RedeemablesManager {
    private readonly enabled: boolean;
    private readonly intervalMs: number;
    private readonly maxRedeemPerClick: number;
    private readonly addresses: string[];
    private readonly claimAddress: string | null;
    private readonly redeemPrivateKey: string | null;
    private readonly rpcUrls: string[];
    private readonly configuredSignerAddress: string | null;
    private readonly redeemSignerAddress: string | null;
    private readonly redeemDisabledReason: string | null;
    private readonly snapshot: RedeemablesSnapshot;
    private timer: NodeJS.Timeout | null = null;
    private inFlight = false;
    private rpcIndex = 0;

    constructor() {
        const configuredPrivateKey = process.env.PRIVATE_KEY?.trim() || null;
        const configuredSignerAddress = addressFromPrivateKey(configuredPrivateKey);
        const redeemKeyCandidates = [
            process.env.REDEEM_PRIVATE_KEY?.trim() || null,
            process.env.TRADING_FUNDER_PRIVATE_KEY?.trim() || null,
            process.env.POLYMARKET_FUNDER_PRIVATE_KEY?.trim() || null,
            configuredPrivateKey,
        ];
        const keyedCandidates = redeemKeyCandidates
            .map((pk) => ({ pk, address: addressFromPrivateKey(pk) }))
            .filter((x) => Boolean(x.pk) && Boolean(x.address));
        const funderAddress = (
            process.env.TRADING_FUNDER_ADDRESS
            ?? process.env.POLYMARKET_FUNDER_ADDRESS
            ?? null
        )?.toString().trim() || null;
        const claimAddress = (
            process.env.CLAIM_ADDRESS
            ?? funderAddress
            ?? keyedCandidates[0]?.address
            ?? configuredSignerAddress
            ?? null
        )?.toString().trim() || null;
        const normalizedClaim = normalizeAddress(claimAddress);
        const matchedSigner = normalizedClaim
            ? keyedCandidates.find((x) => normalizeAddress(x.address) === normalizedClaim) ?? null
            : (keyedCandidates[0] ?? null);
        const redeemPrivateKey = matchedSigner?.pk ?? null;
        const redeemSignerAddress = matchedSigner?.address ?? null;
        const redeemDisabledReason = (() => {
            if (!claimAddress) return "Set CLAIM_ADDRESS (or TRADING_FUNDER_ADDRESS).";
            if (!redeemPrivateKey) {
                return "No private key matches CLAIM_ADDRESS. Set REDEEM_PRIVATE_KEY to that wallet key.";
            }
            return null;
        })();
        const baseAddresses = [claimAddress, configuredSignerAddress].filter((x): x is string => Boolean(x));
        const addressList = parseAddressList(process.env.REDEEMABLES_ADDRESSES, baseAddresses);

        this.enabled = (process.env.REDEEMABLES_ENABLED ?? "true").toLowerCase() !== "false";
        this.intervalMs = Math.max(15000, Number(process.env.REDEEMABLES_SCAN_INTERVAL_MS ?? "30000"));
        this.maxRedeemPerClick = Math.max(1, Number(process.env.REDEEM_NOW_MAX ?? "3"));
        this.addresses = addressList;
        this.claimAddress = claimAddress;
        this.redeemPrivateKey = redeemPrivateKey;
        this.configuredSignerAddress = configuredSignerAddress;
        this.redeemSignerAddress = redeemSignerAddress;
        this.redeemDisabledReason = redeemDisabledReason;
        this.rpcUrls = parseRpcUrls();

        this.snapshot = {
            enabled: this.enabled,
            addresses: this.addresses,
            claimAddress: this.claimAddress,
            configuredSignerAddress: this.configuredSignerAddress,
            redeemSignerAddress: this.redeemSignerAddress,
            redeemReady: !this.redeemDisabledReason,
            redeemDisabledReason: this.redeemDisabledReason,
            totalRedeemables: 0,
            byAddress: [],
            lastScanAt: null,
            lastRedeemAt: null,
            lastRedeemTxHash: null,
            inFlight: false,
            cycles: 0,
            redeemedCount: 0,
            lastError: null,
            rpcUrls: this.rpcUrls,
            activeRpcUrl: this.rpcUrls[0] ?? null,
            history: [],
        };
    }

    start() {
        if (!this.enabled) return;
        this.timer = setInterval(() => { void this.scan(); }, this.intervalMs);
        void this.scan();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    getSnapshot(): RedeemablesSnapshot {
        return { ...this.snapshot, inFlight: this.inFlight };
    }

    async scan() {
        if (this.inFlight) return;
        this.inFlight = true;
        this.snapshot.inFlight = true;
        this.snapshot.lastError = null;
        try {
            const byAddress: Array<{ address: string; redeemables: number }> = [];
            let total = 0;
            for (const address of this.addresses) {
                const cids = await fetchRedeemableConditions(address);
                byAddress.push({ address, redeemables: cids.length });
                total += cids.length;
            }
            this.snapshot.byAddress = byAddress;
            this.snapshot.totalRedeemables = total;
            this.snapshot.lastScanAt = Date.now();
            this.snapshot.cycles += 1;
        } catch (err) {
            this.snapshot.lastError = err instanceof Error ? err.message : String(err);
        } finally {
            this.inFlight = false;
            this.snapshot.inFlight = false;
        }
    }

    async redeemNow() {
        if (this.inFlight) {
            return { ok: false, error: "busy" };
        }
        if (this.redeemDisabledReason) {
            const error = `redeem_misconfigured: ${this.redeemDisabledReason}`;
            this.recordHistory({ ok: false, redeemed: 0, txHash: null, error });
            this.snapshot.lastError = error;
            return { ok: false, error };
        }
        const claimAddress = this.claimAddress;
        if (!claimAddress) {
            const error = "redeem_misconfigured: missing claim address";
            this.recordHistory({ ok: false, redeemed: 0, txHash: null, error });
            this.snapshot.lastError = error;
            return { ok: false, error };
        }
        this.inFlight = true;
        this.snapshot.inFlight = true;
        this.snapshot.lastError = null;
        try {
            const cids = await fetchRedeemableConditions(claimAddress);
            if (!cids.length) {
                this.recordHistory({ ok: true, redeemed: 0, txHash: null, error: null });
                return { ok: true, redeemed: 0, reason: "no_redeemables" };
            }

            let redeemed = 0;
            let lastTxHash: string | null = null;
            for (const conditionId of cids.slice(0, this.maxRedeemPerClick)) {
                const txHash = await this.redeemConditionWithFailover(conditionId);
                if (txHash) {
                    redeemed += 1;
                    lastTxHash = txHash;
                }
            }
            this.snapshot.redeemedCount += redeemed;
            this.snapshot.lastRedeemAt = Date.now();
            this.snapshot.lastRedeemTxHash = lastTxHash;
            this.recordHistory({ ok: true, redeemed, txHash: lastTxHash, error: null });
            await this.scan();
            return { ok: true, redeemed, txHash: lastTxHash };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.snapshot.lastError = msg;
            logger.warn({ err: msg }, "Redeem now failed");
            this.recordHistory({ ok: false, redeemed: 0, txHash: null, error: msg });
            return { ok: false, error: msg };
        } finally {
            this.inFlight = false;
            this.snapshot.inFlight = false;
        }
    }

    private recordHistory(entry: {
        ok: boolean;
        redeemed: number;
        txHash: string | null;
        error: string | null;
    }) {
        this.snapshot.history.unshift({
            at: Date.now(),
            ok: entry.ok,
            redeemed: entry.redeemed,
            txHash: entry.txHash,
            error: entry.error,
        });
        if (this.snapshot.history.length > 20) {
            this.snapshot.history.length = 20;
        }
    }

    private async redeemConditionWithFailover(conditionId: string): Promise<string> {
        let lastErr: unknown = null;
        const total = this.rpcUrls.length;
        for (let i = 0; i < total; i += 1) {
            const idx = (this.rpcIndex + i) % total;
            const rpcUrl = this.rpcUrls[idx];
            this.snapshot.activeRpcUrl = rpcUrl;
            try {
                const provider = new ethers.providers.StaticJsonRpcProvider(
                    { url: rpcUrl, timeout: 15000 },
                    { chainId: 137, name: "matic" },
                );
                const signer = new Wallet(this.redeemPrivateKey!, provider);
                const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, signer);
                const tx = await ctf.redeemPositions(
                    USDC_ADDRESS,
                    ethers.constants.HashZero,
                    conditionId,
                    [1, 2],
                );
                await tx.wait(1);
                this.rpcIndex = idx;
                this.snapshot.activeRpcUrl = rpcUrl;
                return tx.hash;
            } catch (err) {
                lastErr = err;
                const retryable = isRetryableRpcError(err);
                logger.warn(
                    {
                        rpcUrl,
                        retryable,
                        err: err instanceof Error ? err.message : String(err),
                    },
                    "Redeem RPC attempt failed",
                );
                if (!retryable) break;
            }
        }
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "redeem_failed"));
    }
}
