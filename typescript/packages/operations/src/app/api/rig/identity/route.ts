import { SAQI_PRODUCTION_DATABASE_ID } from "@saqi/precedent-iso";

import { getCloudflareEnv } from "@/lib/cloudflare";
import { NO_STORE_HEADERS } from "@/lib/operations-boundary";
import { ProductionDeploymentIdentityRepository } from "@/lib/production-deployment-identity-repository";

// Cloudflare Access protects this origin. This read-only canary also proves
// the Worker is bound to the expected production D1 schema.
// eslint-disable-next-line @typescript-eslint/naming-convention -- Next.js route handlers use HTTP method exports.
export async function GET(): Promise<Response> {
  const env = getCloudflareEnv();
  if (
    !(await new ProductionDeploymentIdentityRepository(
      env.DB
    ).matchesProduction())
  )
    return Response.json(
      { error: "PRODUCTION_DATABASE_IDENTITY_MISMATCH", ok: false },
      { headers: NO_STORE_HEADERS, status: 503 }
    );
  return Response.json(
    {
      databaseId: SAQI_PRODUCTION_DATABASE_ID,
      schemaId: "saqi.publication-identity",
      schemaVersion: 1,
      service: "saqi-production",
    },
    { headers: NO_STORE_HEADERS }
  );
}
