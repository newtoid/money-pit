import { ArbScannerConfig } from "./config";
import { BinaryMarket, OpportunityCost } from "./types";

export class FeeModel {
    constructor(private readonly config: ArbScannerConfig) {}

    estimateCost(market: BinaryMarket): OpportunityCost {
        const notes: string[] = [];

        if (this.config.feeCostOverride !== null) {
            notes.push("fee_cost_override");
            return {
                explicitCostBuffer: this.config.costBuffer,
                feeCost: this.config.feeCostOverride,
                totalCostBuffer: this.config.costBuffer + this.config.feeCostOverride,
                notes,
            };
        }

        // Gamma currently exposes fields like `fee`, `feesEnabled`, and `feeType`, but the exact
        // unit semantics are not stable enough here to safely convert into a per-share all-in cost.
        // In v1 we keep fee handling explicit and conservative by isolating it in COST_BUFFER.
        if (market.feesEnabled === true) {
            notes.push(`fees_enabled_raw=${market.feeRaw ?? "unknown"}`);
        } else if (market.feesEnabled === false) {
            notes.push("fees_disabled_raw");
        } else if (market.feeRaw !== null) {
            notes.push(`fee_raw=${market.feeRaw}`);
        }

        return {
            explicitCostBuffer: this.config.costBuffer,
            feeCost: 0,
            totalCostBuffer: this.config.costBuffer,
            notes,
        };
    }
}
