import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = fileURLToPath(
  new URL("../chrome/saqi-collector/", import.meta.url)
);
const output = process.argv[2];
const configuredOrigin = process.env.SAQI_SOURCE_BASE_URL;
if (!output || !configuredOrigin)
  throw new Error(
    "Provide an external output directory and SAQI_SOURCE_BASE_URL."
  );
const origin = new URL(configuredOrigin);
if (
  origin.protocol !== "https:" ||
  origin.username ||
  origin.password ||
  origin.port ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error("SAQI_SOURCE_BASE_URL must be a clean HTTPS origin.");
const outdir = resolve(output);
const withinRepository = relative(root, outdir);
if (!withinRepository.startsWith("../"))
  throw new Error("Build the configured extension outside the repository.");
await mkdir(outdir, { recursive: true, mode: 0o700 });
await build({
  entryPoints: ["background", "controller", "popup", "project"].map((name) =>
    resolve(source, `${name}.ts`)
  ),
  outdir,
  target: "chrome120",
  define: { SAQI_SOURCE_ORIGIN: JSON.stringify(origin.origin) },
});
const manifest = JSON.parse(
  await readFile(resolve(source, "manifest.json"), "utf8")
);
manifest["host_permissions"] = [`${origin.origin}/*`];
await writeFile(
  resolve(outdir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o600 }
);
await Promise.all(
  ["popup.html", "popup.css"].map((name) =>
    copyFile(resolve(source, name), resolve(outdir, name))
  )
);
