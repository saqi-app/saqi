import { z } from "zod";

export const SourceNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{1,63}$/u);
export const SourceOriginSchema = z
  .url({ protocol: /^https$/u })
  .regex(
    /^https:\/\/(?:\[[\d.:A-Fa-f]+\]|[^\s/?#:@]+)\/?$/u,
    "Source origin must be a clean HTTPS origin",
  )
  .transform((value) => (value.endsWith("/") ? value.slice(0, -1) : value));
