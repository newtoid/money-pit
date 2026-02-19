import { ClobClient } from "@polymarket/clob-client";
import { logger } from "./logger";

function toNum(v: unknown): number | null {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function parseAllowanceValue(payload: any): number | null {
    const direct =
        toNum(payload?.allowance)
        ?? toNum(payload?.maxOrderSize)
        ?? toNum(payload?.max_size);
    if (direct !== null) return direct;

    const allowances = payload?.allowances;
    if (allowances && typeof allowances === "object") {
        let best = 0;
        for (const v of Object.values(allowances)) {
            const n = toNum(v);
            if (n !== null && n > best) best = n;
        }
        return best;
    }
    return null;
}

export async function runClobPreflight(client: ClobClient) {
    try {
        const before = await client.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
        const beforeBalance =
            toNum((before as any)?.balance)
            ?? toNum((before as any)?.available)
            ?? toNum((before as any)?.availableBalance);
        const beforeAllowance = parseAllowanceValue(before);

        logger.info(
            {
                beforeBalance,
                beforeAllowance,
            },
            "CLOB preflight balance/allowance",
        );

        // Best-effort: refresh/initialize allowance on CLOB side.
        await client.updateBalanceAllowance({ asset_type: "COLLATERAL" as any });

        const after = await client.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
        const afterBalance =
            toNum((after as any)?.balance)
            ?? toNum((after as any)?.available)
            ?? toNum((after as any)?.availableBalance);
        const afterAllowance = parseAllowanceValue(after);

        logger.info(
            {
                afterBalance,
                afterAllowance,
            },
            "CLOB preflight balance/allowance after update",
        );
        if ((afterAllowance ?? 0) <= 0) {
            logger.warn(
                "Collateral allowance is still zero. Open Polymarket UI with this wallet and complete the approval flow once.",
            );
        }
    } catch (err) {
        logger.warn({ err }, "CLOB preflight failed (continuing)");
    }
}
