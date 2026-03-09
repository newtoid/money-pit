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
    console.log(`Max drawdown: ${report.maxDrawdown.toFixed(6)}`);
    console.log(`Open positions: ${report.positionsOpen}`);
    console.log(`Released exposure: ${report.releasedExposure.toFixed(6)}`);
    console.log(`Missed trade reasons: ${JSON.stringify(report.missedTradeReasons)}`);
    console.log(`Stale data summary: ${JSON.stringify(report.staleDataSummary)}`);
    console.log(`Liquidity denial summary: ${JSON.stringify(report.liquidityDenialSummary)}`);
    console.log(`Partial fill damage: ${JSON.stringify(report.partialFillDamageReport)}`);
}

main();
