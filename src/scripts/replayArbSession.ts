import { loadArbScannerConfig } from "../arbScanner/config";
import { runReplay } from "../arbScanner/replayEngine";

function parseInputPath(args: string[]): string | null {
    const direct = args.find((arg) => arg.startsWith("--input="));
    if (direct) return direct.slice("--input=".length);
    const index = args.indexOf("--input");
    if (index >= 0 && index + 1 < args.length) return args[index + 1] ?? null;
    return null;
}

function printUsage() {
    console.log("Usage: npm run arb:replay -- --input path/to/session.jsonl");
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        printUsage();
        return;
    }

    const inputPath = parseInputPath(args);
    if (!inputPath) {
        printUsage();
        process.exit(1);
    }

    const config = loadArbScannerConfig();
    const report = runReplay(inputPath, config);
    console.log(`Replay file: ${inputPath}`);
    console.log(`Markets loaded: ${report.marketsLoaded}`);
    console.log(`WS events processed: ${report.wsEventsProcessed}`);
    console.log(`Trade count: ${report.tradeCount}`);
    console.log(`Position opens: ${report.positionOpens}`);
    console.log(`Positions resolved: ${report.positionsResolved}`);
    console.log(`Win rate: ${(report.winRate * 100).toFixed(2)}%`);
    console.log(`Average edge: ${report.averageEdge.toFixed(6)}`);
    console.log(`Realized PnL: ${report.realizedPnl.toFixed(6)}`);
    console.log(`Daily realized PnL: ${report.dailyRealizedPnl.toFixed(6)}`);
    console.log(`Max drawdown: ${report.maxDrawdown.toFixed(6)}`);
    console.log(`Open positions: ${report.positionsOpen}`);
    console.log(`Released exposure: ${report.releasedExposure.toFixed(6)}`);
    console.log(`Missed trade reasons: ${JSON.stringify(report.missedTradeReasons)}`);
    console.log(`Stale data summary: ${JSON.stringify(report.staleDataSummary)}`);
    console.log(`Liquidity denial summary: ${JSON.stringify(report.liquidityDenialSummary)}`);
    console.log(`Daily loss summary: ${JSON.stringify(report.dailyLossSummary)}`);
    console.log(`Current state: ${JSON.stringify(report.currentState)}`);
    console.log(`Day rollover: ${JSON.stringify(report.dayRollover)}`);
    console.log(`Unresolved aging: ${JSON.stringify(report.unresolvedAging)}`);
    console.log(`Settlement summary: ${JSON.stringify(report.settlementSummary)}`);
    console.log(`Settlement coverage: ${JSON.stringify(report.settlementCoverage)}`);
    console.log(`Execution outcomes: ${JSON.stringify(report.executionOutcomes)}`);
    console.log(`Average detection->execution delay ms: ${report.averageDetectionToExecutionDelayMs.toFixed(2)}`);
    console.log(`Opportunity invalidation rate: ${(report.opportunityInvalidationRate * 100).toFixed(2)}%`);
    console.log(`Execution success rate: ${(report.executionSuccessRate * 100).toFixed(2)}%`);
    console.log(`Queue mode: ${report.executionOutcomes.queueMode}`);
    console.log(`Average visible->fillable haircut: ${report.executionOutcomes.averageVisibleToFillableHaircut.toFixed(6)}`);
    console.log(`Execution success reduction vs visible baseline: ${(report.executionOutcomes.executionSuccessReductionVsVisibleBaseline * 100).toFixed(2)}%`);
    console.log(`Average levels consumed per successful leg: ${report.executionOutcomes.averageLevelsConsumedPerSuccessfulLeg.toFixed(2)}`);
    console.log(`Average fill deviation from detected best ask: ${report.executionOutcomes.averageFillPriceDeviationFromDetectedBestAsk.toFixed(6)}`);
    console.log(`Average sweep slippage from depth: ${report.executionOutcomes.averageSweepSlippageFromDepth.toFixed(6)}`);
    console.log(`Execution damage: ${JSON.stringify(report.executionDamage)}`);
    console.log(`Stranded damage records: ${report.strandedDamageRecords.length}`);
    console.log(`Execution state summary: ${JSON.stringify(report.executionStateSummary)}`);
    console.log(`Partial fill damage: ${JSON.stringify(report.partialFillDamageReport)}`);
}

main();
