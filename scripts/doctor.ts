import fs from "node:fs";
import path from "node:path";

const recordingsDir = path.resolve(process.cwd(), "data/recordings");

if (!fs.existsSync(recordingsDir)) {
    console.log(JSON.stringify({
        ok: true,
        recordingsDir,
        message: "recordings directory does not exist yet",
    }, null, 2));
    process.exit(0);
}

const files = fs.readdirSync(recordingsDir).filter((name) => name.endsWith(".jsonl"));
console.log(JSON.stringify({
    ok: true,
    recordingsDir,
    recordingFiles: files,
    recordingCount: files.length,
}, null, 2));
