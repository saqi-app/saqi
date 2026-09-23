import { NextResponse } from "next/server";

import {
  hasJsonContentType,
  isTrustedMutationRequest,
} from "@/lib/operations-boundary";

function post(request: Request) {
  if (!isTrustedMutationRequest(request) || !hasJsonContentType(request)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  return NextResponse.json(
    {
      error:
        "Gemini translation has been retired. Translation runs through the Codex runner.",
      code: "TRANSLATION_PROVIDER_RETIRED",
    },
    { status: 410 }
  );
}

export { post as POST };
