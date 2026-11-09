import crypto from "node:crypto";

export function isAdminAuthorized(req: Request): boolean {
  const secret = process.env.HEYBROC_ADMIN_SECRET?.trim();
  if (!secret) return false;
  const authHeader = req.headers.get("authorization") || "";
  const expectedDigest = crypto
    .createHash("sha256")
    .update(`Bearer ${secret}`, "utf8")
    .digest();
  const actualDigest = crypto
    .createHash("sha256")
    .update(authHeader, "utf8")
    .digest();
  return crypto.timingSafeEqual(expectedDigest, actualDigest);
}

