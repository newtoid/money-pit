import { ethers, Wallet } from "ethers";
import { env } from "./config";
import { logger } from "./logger";

const DATA_API = "https://data-api.polymarket.com";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

type Position = {
    conditionId?: string;
    size?: string | number;
    redeemable?: boolean;
    asset?: string;
};

type ClaimerSnapshot = {
    enabled: boolean;
    claimAddress: string | null;
    signerAddress: string | null;
    addressMismatch: boolean;
    lastRunAt: number | null;
    lastSuccessAt: number | null;
    lastError: string | null;
    cycles: number;
    claimedConditions: number;
    lastCycleRedeemables: number;
    inFlight: boolean;
    lastRpcUrl: string | null;
};

const CTF_ABI = [
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];

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

async function fetchRedeemableConditionIds(user: string): Promise<string[]> {
    const url = `${DATA_API}/positions?user=${encodeURIComponent(user)}&sizeThreshold=0`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`positions fetch failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as Position[];
    if (!Array.isArray(body)) return [];

    const out = new Set<string>();
    for (const p of body) {
        if (!p?.redeemable) continue;
        if (parseSize(p.size) <= 0) continue;
        const cid = normalizeConditionId(String(p.conditionId ?? ""));
        if (cid) out.add(cid);
    }
    return Array.from(out);
}

export class AutoClaimer {
    private readonly enabled: boolean;
    private readonly intervalMs: number;
    private readonly maxPerCycle: number;
    private readonly privateKey: string | null;
    private readonly rpcUrls: string[];
    private readonly wallet: Wallet | null;
    private readonly claimAddress: string | null;
    private readonly signerAddress: string | null;
    private readonly allowAddressMismatch: boolean;
    private timer: NodeJS.Timeout | null = null;
    private inFlight = false;
    private snapshot: ClaimerSnapshot;

    constructor() {
        this.enabled = env.AUTO_CLAIM_ENABLED && !env.DRY_RUN;
        this.intervalMs = Math.max(30000, env.AUTO_CLAIM_INTERVAL_MS);
        this.maxPerCycle = Math.max(1, env.AUTO_CLAIM_MAX_PER_CYCLE);

        const pk = process.env.PRIVATE_KEY?.trim() || null;
        this.privateKey = pk;
        const configured = env.POLYGON_RPC_URL?.trim();
        this.rpcUrls = [
            configured,
            "https://polygon-rpc.com",
            "https://rpc.ankr.com/polygon",
            "https://polygon-bor-rpc.publicnode.com",
        ].filter((u, i, arr): u is string => Boolean(u) && arr.indexOf(u) === i);
        this.wallet = pk ? new Wallet(pk) : null;
        this.signerAddress = this.wallet?.address ?? null;
        this.claimAddress = (env.CLAIM_ADDRESS?.trim() || this.wallet?.address || process.env.POLYMARKET_FUNDER_ADDRESS?.trim() || null);
        this.allowAddressMismatch = (process.env.AUTO_CLAIM_ALLOW_ADDRESS_MISMATCH ?? "false").toLowerCase() === "true";

        this.snapshot = {
            enabled: this.enabled,
            claimAddress: this.claimAddress,
            signerAddress: this.signerAddress,
            addressMismatch: Boolean(
                this.claimAddress
                && this.signerAddress
                && this.claimAddress.toLowerCase() !== this.signerAddress.toLowerCase(),
            ),
            lastRunAt: null,
            lastSuccessAt: null,
            lastError: null,
            cycles: 0,
            claimedConditions: 0,
            lastCycleRedeemables: 0,
            inFlight: false,
            lastRpcUrl: null,
        };
    }

    start() {
        if (!this.enabled) {
            if (env.AUTO_CLAIM_ENABLED && env.DRY_RUN) {
                logger.info("Auto-claim skipped because DRY_RUN=true");
            }
            return;
        }
        if (
            this.snapshot.addressMismatch
            && !this.allowAddressMismatch
        ) {
            logger.warn(
                {
                    claimAddress: this.claimAddress,
                    signerAddress: this.signerAddress,
                },
                "Auto-claim disabled: CLAIM_ADDRESS differs from tx signer; set AUTO_CLAIM_ALLOW_ADDRESS_MISMATCH=true to force (not recommended)",
            );
            return;
        }
        if (!this.wallet || !this.privateKey || !this.claimAddress || !this.rpcUrls.length) {
            logger.warn("Auto-claim enabled but wallet/private key/rpc/claim address is missing; claimer disabled");
            return;
        }
        logger.info(
            {
                claimAddress: this.claimAddress,
                intervalMs: this.intervalMs,
                maxPerCycle: this.maxPerCycle,
                rpcUrls: this.rpcUrls,
            },
            "Auto-claimer enabled",
        );
        this.timer = setInterval(() => {
            void this.runCycle();
        }, this.intervalMs);
        void this.runCycle();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    getSnapshot(): ClaimerSnapshot {
        return { ...this.snapshot, inFlight: this.inFlight };
    }

    private async runCycle() {
        if (this.inFlight || !this.privateKey || !this.claimAddress) return;
        this.inFlight = true;
        this.snapshot.inFlight = true;
        this.snapshot.lastRunAt = Date.now();
        this.snapshot.cycles += 1;
        this.snapshot.lastError = null;

        try {
            const redeemables = await fetchRedeemableConditionIds(this.claimAddress);
            this.snapshot.lastCycleRedeemables = redeemables.length;
            if (!redeemables.length) {
                return;
            }

            const candidates = redeemables.slice(0, this.maxPerCycle);
            for (const conditionId of candidates) {
                const tx = await this.submitRedeemWithRpcFallback(conditionId);
                this.snapshot.claimedConditions += 1;
                this.snapshot.lastSuccessAt = Date.now();
                logger.info({ conditionId, txHash: tx.hash }, "Redeem confirmed");
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.snapshot.lastError = message;
            logger.error({ err }, "Auto-claim cycle failed");
        } finally {
            this.inFlight = false;
            this.snapshot.inFlight = false;
        }
    }

    private async submitRedeemWithRpcFallback(conditionId: string) {
        let lastErr: unknown = null;
        for (const rpcUrl of this.rpcUrls) {
            try {
                const provider = new ethers.providers.StaticJsonRpcProvider(
                    { url: rpcUrl, timeout: 15000 },
                    { chainId: 137, name: "matic" },
                );
                const signer = new Wallet(this.privateKey!, provider);
                const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, signer);

                const tx = await ctf.redeemPositions(
                    USDC_ADDRESS,
                    ethers.constants.HashZero,
                    conditionId,
                    [1, 2],
                );
                this.snapshot.lastRpcUrl = rpcUrl;
                logger.info({ conditionId, txHash: tx.hash, rpcUrl }, "Submitted redeemPositions");
                await tx.wait(1);
                return tx;
            } catch (err) {
                lastErr = err;
                logger.warn(
                    { conditionId, rpcUrl, err: err instanceof Error ? err.message : String(err) },
                    "Redeem attempt failed on RPC endpoint",
                );
            }
        }
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
}
