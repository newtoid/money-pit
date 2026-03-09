import { loadArbScannerConfig } from "../src/config/arb";
import { runReplay } from "../src/arbScanner/replayEngine";

function argValue(args: string[], name: string): string | null {
    const direct = args.find((arg) => arg.startsWith(`${name}=`));
    if (direct) return direct.slice(name.length + 1);
    const index = args.indexOf(name);
    if (index >= 0 && index + 1 < args.length) return args[index + 1] ?? null;
    return null;
}

const args = process.argv.slice(2);
const input = argValue(args, "--input");

if (!input) {
    console.log("Usage: tsx scripts/replay.ts --input data/recordings/session.jsonl");
    process.exit(1);
}

const report = runReplay(input, loadArbScannerConfig());
console.log(JSON.stringify(report, null, 2));
