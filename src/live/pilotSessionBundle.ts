import fs from "node:fs";
import path from "node:path";
import {
    PilotSessionArtifactType,
    PilotSessionBundleArtifactRef,
    PilotSessionBundleExportResult,
    PilotSessionBundleManifest,
} from "./types";
import {
    readPilotSessionManifest,
    recordPilotSessionBundleExport,
} from "./pilotSession";

function artifactFileName(artifactType: PilotSessionArtifactType | "session_manifest") {
    if (artifactType === "pilot_result") return "pilot.result.json";
    if (artifactType === "order_baseline") return "order-baseline.json";
    if (artifactType === "verification_result") return "verification.result.json";
    if (artifactType === "reconciliation_result") return "reconciliation.result.json";
    return "session.manifest.json";
}

function copyIfPresent(args: {
    artifactType: PilotSessionArtifactType | "session_manifest";
    sourcePath: string | null;
    bundleDir: string;
    copiedAtMs: number;
}): PilotSessionBundleArtifactRef {
    if (!args.sourcePath) {
        return {
            artifactType: args.artifactType,
            sourcePath: null,
            bundledPath: null,
            status: "missing_source",
            copiedAtMs: args.copiedAtMs,
            notes: ["source_path_missing"],
        };
    }
    const resolvedSource = path.resolve(args.sourcePath);
    if (!fs.existsSync(resolvedSource)) {
        return {
            artifactType: args.artifactType,
            sourcePath: resolvedSource,
            bundledPath: null,
            status: "missing_source",
            copiedAtMs: args.copiedAtMs,
            notes: ["source_file_missing"],
        };
    }
    const bundledPath = path.resolve(args.bundleDir, artifactFileName(args.artifactType));
    fs.copyFileSync(resolvedSource, bundledPath);
    return {
        artifactType: args.artifactType,
        sourcePath: resolvedSource,
        bundledPath,
        status: "bundled",
        copiedAtMs: args.copiedAtMs,
        notes: [],
    };
}

export function defaultPilotSessionBundleRootDir(resultDir: string) {
    return path.resolve(resultDir, "bundles");
}

export function createPilotSessionBundleId(args: {
    pilotSessionId: string;
    exportedAtMs: number;
}) {
    return `${args.pilotSessionId}-bundle-${args.exportedAtMs}`;
}

export function exportPilotSessionBundle(args: {
    manifestPath: string;
    bundleRootDir: string;
    exportedAtMs?: number;
}): PilotSessionBundleExportResult {
    const sessionManifest = readPilotSessionManifest(args.manifestPath);
    const exportedAtMs = args.exportedAtMs ?? Date.now();
    const bundleId = createPilotSessionBundleId({
        pilotSessionId: sessionManifest.pilotSessionId,
        exportedAtMs,
    });
    const bundleDir = path.resolve(args.bundleRootDir, bundleId);
    fs.mkdirSync(bundleDir, { recursive: true });

    const artifacts: PilotSessionBundleArtifactRef[] = [
        copyIfPresent({
            artifactType: "session_manifest",
            sourcePath: args.manifestPath,
            bundleDir,
            copiedAtMs: exportedAtMs,
        }),
        copyIfPresent({
            artifactType: "pilot_result",
            sourcePath: sessionManifest.latestArtifactPaths.pilotResult,
            bundleDir,
            copiedAtMs: exportedAtMs,
        }),
        copyIfPresent({
            artifactType: "order_baseline",
            sourcePath: sessionManifest.latestArtifactPaths.orderBaseline,
            bundleDir,
            copiedAtMs: exportedAtMs,
        }),
        copyIfPresent({
            artifactType: "verification_result",
            sourcePath: sessionManifest.latestArtifactPaths.verificationResult,
            bundleDir,
            copiedAtMs: exportedAtMs,
        }),
        copyIfPresent({
            artifactType: "reconciliation_result",
            sourcePath: sessionManifest.latestArtifactPaths.reconciliationResult,
            bundleDir,
            copiedAtMs: exportedAtMs,
        }),
    ];

    const missingArtifactTypes = artifacts
        .filter((item) => item.status !== "bundled")
        .map((item) => item.artifactType);

    const bundleManifestPath = path.resolve(bundleDir, "bundle.manifest.json");
    const bundleManifest: PilotSessionBundleManifest = {
        bundleId,
        pilotSessionId: sessionManifest.pilotSessionId,
        sourceSessionManifestPath: path.resolve(args.manifestPath),
        bundleDir,
        bundleManifestPath,
        exportedAtMs,
        sourceLabel: "pilot_session_bundle_export",
        currentTerminalState: sessionManifest.currentTerminalState,
        artifacts,
        missingArtifactTypes,
        rawSourceMetadata: {
            sessionManifestPath: path.resolve(args.manifestPath),
            latestBundleManifestPath: sessionManifest.latestBundleManifestPath ?? null,
        },
    };

    fs.writeFileSync(bundleManifestPath, `${JSON.stringify(bundleManifest, null, 2)}\n`, "utf8");

    const capture = recordPilotSessionBundleExport({
        manifestPath: args.manifestPath,
        bundleRef: {
            bundleId,
            bundleManifestPath,
            bundleDir,
            exportedAtMs,
            missingArtifactTypes,
        },
    });

    return {
        pilotSessionId: sessionManifest.pilotSessionId,
        bundleId,
        bundleDir,
        bundleManifestPath,
        manifestPath: capture.manifestPath,
        bundleManifest,
        sessionManifest: capture.manifest,
    };
}
