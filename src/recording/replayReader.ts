import fs from "node:fs";
import path from "node:path";
import { RecordedEvent } from "../arbScanner/types";

export function readRecordedEvents(filePath: string): RecordedEvent[] {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    const content = fs.readFileSync(resolvedPath, "utf8");
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedEvent);
}
