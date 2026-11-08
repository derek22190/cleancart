import crypto from "node:crypto";

export function isAdminAuthorized(req: Request): boolean {
  const secret = process.env.HEYBROC_ADMIN_SECRET?.trim();
  if (!secret) return false;
  const authHeader = req.headers.get("authorization") || "";
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(authHeader, "utf8");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
