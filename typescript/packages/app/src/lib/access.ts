import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

export interface AccessEnv {
  SAQI_ACCESS_AUDIENCE?: string;
  SAQI_ACCESS_SERVICE_IDENTITIES?: string;
  SAQI_ACCESS_TEAM_ORIGIN?: string;
}

let jwks: null | ReturnType<typeof createRemoteJWKSet> = null;
let jwksIssuer: null | string = null;

interface AccessIdentity {
  email: string;
  subject: string;
}

const AccessClaimsSchema = z.object({
  email: z.email().max(320),
  sub: z.string().trim().min(1).max(256),
  type: z.literal("app"),
});

const ServiceClaimsSchema = z.object({
  common_name: z.string().trim().min(1).max(256),
  type: z.literal("app"),
});

export function accessIdentityFromClaims(
  payload: unknown,
  allowedServiceCommonNames: readonly string[] = []
): AccessIdentity | null {
  const claims = AccessClaimsSchema.safeParse(payload);
  if (claims.success)
    return { email: claims.data.email, subject: claims.data.sub };
  const service = ServiceClaimsSchema.safeParse(payload);
  if (
    !service.success ||
    !allowedServiceCommonNames.includes(service.data.common_name)
  )
    return null;
  return {
    email: `${service.data.common_name}@service-token.invalid`,
    subject: `service:${service.data.common_name}`,
  };
}

export function accessIssuer(teamDomain: string): null | string {
  try {
    const url = new URL(teamDomain);
    const isAccessHost =
      url.hostname.endsWith(".cloudflareaccess.com") &&
      url.hostname !== "cloudflareaccess.com";
    if (
      url.protocol !== "https:" ||
      !isAccessHost ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export async function verifyAccessIdentity(
  request: Request,
  env: AccessEnv
): Promise<AccessIdentity | null> {
  const {
    SAQI_ACCESS_TEAM_ORIGIN: teamDomain,
    SAQI_ACCESS_AUDIENCE: aud,
    SAQI_ACCESS_SERVICE_IDENTITIES: serviceNames,
  } = env;

  if (!teamDomain || !aud) return null;
  const issuer = accessIssuer(teamDomain);
  if (!issuer) return null;

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16_384) return null;

  if (!jwks || jwksIssuer !== issuer) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksIssuer = issuer;
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      issuer,
      audience: aud,
    });
    const allowedServiceCommonNames = (serviceNames ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return accessIdentityFromClaims(payload, allowedServiceCommonNames);
  } catch {
    return null;
  }
}
