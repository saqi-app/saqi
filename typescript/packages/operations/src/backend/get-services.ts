import {
  CorpusImportCoordinator,
  D1CorpusRevisionStore,
  D1PoemStore,
  D1ProductionResolutionStore,
} from "@saqi/precedent-node";
import { drizzle } from "drizzle-orm/d1";

import { getCloudflareEnv } from "../lib/cloudflare";

export function getServices() {
  const { DB, SAQI_SOURCE_BASE_URL, SAQI_SOURCE_NAME } = getCloudflareEnv();
  const db = drizzle(DB);

  const poemStore = new D1PoemStore(db);
  const productionResolution = new D1ProductionResolutionStore(db, {
    sourceName: SAQI_SOURCE_NAME,
  });
  const corpusRevision = new D1CorpusRevisionStore(db, {
    sourceBaseUrl: SAQI_SOURCE_BASE_URL,
    sourceName: SAQI_SOURCE_NAME,
  });
  const corpusImport = new CorpusImportCoordinator(corpusRevision);
  return {
    corpusImport,
    corpusRevision,
    poemStore,
    productionResolution,
  };
}
