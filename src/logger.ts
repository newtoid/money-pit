import pino from "pino";
import { env } from "./config";

const level = env.LOG_LEVEL ?? "info";
const logFormat = (process.env.LOG_FORMAT ?? "").trim().toLowerCase();
const forceJson = logFormat === "json";
const forcePretty = logFormat === "pretty";
const isTty = Boolean(process.stdout.isTTY);
const usePretty = forcePretty || (!forceJson && isTty);

export const logger = usePretty
    ? pino({
        level,
        base: undefined,
        transport: {
            target: "pino-pretty",
            options: {
                colorize: true,
                translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
                ignore: "pid,hostname",
                messageFormat: "{msg}",
                singleLine: true,
            },
        },
    })
    : pino({
        level,
        timestamp: pino.stdTimeFunctions.isoTime,
    });
