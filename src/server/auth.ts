import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";

export interface ServerSecurityConfig {
  host: string;
  port: number;
  apiToken: string;
  authRequired: boolean;
  isPublicBind: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const WEAK_PLACEHOLDER_TOKENS = new Set([
  "changeme",
  "change-me",
  "your-token",
  "your_token",
  "my-token",
  "my_token",
  "secret",
  "password",
  "token",
  "example",
  "replace-me",
]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

export function loadServerSecurityConfig(
  env: NodeJS.ProcessEnv = process.env
): ServerSecurityConfig {
  const host = env.NANOGEM_HOST?.trim() || env.HOST?.trim() || "127.0.0.1";
  const rawPort = env.PORT?.trim() || "3000";
  const port = Number.parseInt(rawPort, 10);
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${rawPort}": expected an integer between 1 and 65535.`);
  }

  const apiToken = env.NANOGEM_API_TOKEN?.trim() || env.NANOGEM_AUTH_TOKEN?.trim() || "";
  const isPublicBind = !isLoopbackHost(host);

  if (isPublicBind) {
    if (!apiToken) {
      throw new Error(
        `Security Error: Refusing to bind NanoGem to non-loopback address "${host}" without NANOGEM_API_TOKEN. ` +
          `Either bind to 127.0.0.1 (default) or set a strong NANOGEM_API_TOKEN (>= 16 characters).`
      );
    }
    if (apiToken.length < 16 || WEAK_PLACEHOLDER_TOKENS.has(apiToken.toLowerCase())) {
      throw new Error(
        `Security Error: NANOGEM_API_TOKEN must be at least 16 characters and non-placeholder when binding to "${host}".`
      );
    }
  }

  return {
    host,
    port,
    apiToken,
    authRequired: Boolean(apiToken) || isPublicBind,
    isPublicBind,
  };
}

export function constantTimeTokenEqual(expected: string, candidate: string): boolean {
  if (!expected || !candidate) return false;
  const expectedDigest = crypto.createHash("sha256").update(expected, "utf-8").digest();
  const candidateDigest = crypto.createHash("sha256").update(candidate, "utf-8").digest();
  return crypto.timingSafeEqual(expectedDigest, candidateDigest);
}

export function extractBearerOrHeaderToken(req: Request): string {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  const customHeader = req.headers["x-nanogem-token"];
  if (typeof customHeader === "string" && customHeader.trim()) {
    return customHeader.trim();
  }
  return "";
}

export function applySecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("X-Frame-Options", "DENY");
  }
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

export function createApiAuthMiddleware(config: ServerSecurityConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Allow unauthenticated healthcheck with minimal status only.
    if (req.path === "/health" && req.method === "GET") {
      next();
      return;
    }

    if (config.apiToken) {
      const provided = extractBearerOrHeaderToken(req);
      if (!constantTimeTokenEqual(config.apiToken, provided)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        res.status(401).json({
          error:
            "Unauthorized: valid Authorization: Bearer <NANOGEM_API_TOKEN> or X-NanoGem-Token header is required.",
        });
        return;
      }
      next();
      return;
    }

    // No token configured: only permitted when bound to loopback AND request comes from loopback.
    if (!config.isPublicBind && isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
      next();
      return;
    }

    res.status(403).json({
      error: "Forbidden: non-loopback access requires NANOGEM_API_TOKEN.",
    });
  };
}
