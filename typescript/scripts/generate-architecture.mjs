import console from "node:console";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import process from "node:process";

import ts from "typescript";

const root = join(import.meta.dirname, "..");
const packagesRoot = join(root, "packages");
const output = join(packagesRoot, "site", "src", "generated", "architecture.json");
const diagramsRoot = join(packagesRoot, "site", "public", "docs", "diagrams");
const check = process.argv.includes("--check");
const packageEntries = await readdir(packagesRoot, { withFileTypes: true });
const packages = packageEntries
  .filter((item) => item.isDirectory())
  .map((item) => item.name)
  .toSorted();
const manifests = new Map(await Promise.all(packages.map(async (name) => [name, JSON.parse(await readFile(join(packagesRoot, name, "package.json"), "utf8"))])));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx", ".js", ".mjs", ".astro"].includes(extname(path)) ? [path] : [];
  }));
  return nested.flat().toSorted();
}

function imports(file, source) {
  // Astro frontmatter is TypeScript; its template is deliberately excluded.
  const content = file.endsWith(".astro") ? source.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? "" : source;
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}

const packageSourceEntries = await Promise.all(packages.map(async (name) => {
  const files = await sourceFiles(join(packagesRoot, name, "src"));
  return Promise.all(files.map(async (file) => [relative(root, file), imports(file, await readFile(file, "utf8"))]));
}));
const sourceImports = new Map(packageSourceEntries.flat());

const packageEdges = new Set();
for (const [file, dependencies] of sourceImports) {
  const owner = file.split("/", 2)[1];
  for (const specifier of dependencies) {
    const target = [...manifests].find(([, manifest]) => specifier === manifest.name || specifier.startsWith(`${manifest.name}/`))?.[0];
    if (target && target !== owner) packageEdges.add(`${owner}|${target}`);
  }
}
const packageDiagram = `${["flowchart LR", ...packages.map((name) => `  ${name.replaceAll("-", "_")}["${name}: ${manifests.get(name).description ?? "package"}"]`), ...[...packageEdges].toSorted().map((edge) => {
  const [from, to] = edge.split("|", 2);
  return `  ${from.replaceAll("-", "_")} --> ${to.replaceAll("-", "_")}`;
})].join("\n")}\n`;

const site = "site";
const siteFiles = await sourceFiles(join(packagesRoot, site, "src", "pages"));
const routeFiles = siteFiles.filter((file) => file.endsWith(".astro") || file.endsWith(".ts"));
const routeRows = [];
const routeDiagram = ["flowchart LR", '  browser["Reader"]', '  d1[("Cloudflare D1")]'];
for (const [index, file] of routeFiles.entries()) {
  const route = relative(join(packagesRoot, site, "src", "pages"), file).replace(/(?:\/index)?\.astro$|\.ts$/, "").replaceAll(/\[(\w+)\]/g, ":$1");
  const path = route === "index" ? "/" : `/${route}`;
  const id = `route${index}`;
  const dependencies = sourceImports.get(relative(root, file)) ?? [];
  const modules = dependencies.filter((specifier) => specifier.startsWith("../") || specifier.startsWith("../../") || specifier.startsWith("../../../"));
  routeRows.push({ path, source: relative(root, file), imports: modules });
  routeDiagram.push(`  ${id}["${path}"]`, `  browser --> ${id}`);
  for (const module of modules) {
    const label = module.split("/").at(-1).replace(/\.(?:astro|tsx?|m?js)$/, "").replaceAll(/[^a-zA-Z0-9]/g, "");
    const moduleId = `module_${label}`;
    routeDiagram.push(`  ${moduleId}["${label}"]`, `  ${id} --> ${moduleId}`);
    if (label === "catalog") routeDiagram.push(`  ${moduleId} --> d1`);
  }
}
const routesMermaid = `${[...new Set(routeDiagram)].join("\n")}\n`;

const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function preview(title, rows) {
  const width = 1260;
  const height = 108 + rows.length * 72;
  const items = rows.map((row, index) => {
    const y = 86 + index * 72;
    const targets = row.targets.length ? row.targets.join("  ·  ") : "No local imports";
    return `<g><rect x="24" y="${y}" width="1212" height="58" rx="14" fill="${index % 2 ? "#eaf4ef" : "#f3f8f4"}"/><rect x="36" y="${y + 9}" width="320" height="40" rx="10" fill="#174b3d"/><text x="52" y="${y + 35}" fill="#fff" font-size="17" font-weight="650">${xml(row.label)}</text><path d="M370 ${y + 29}h35m-10-8 10 8-10 8" stroke="#26916c" stroke-width="2" fill="none"/><text x="420" y="${y + 35}" fill="#1b4e3d" font-size="15">${xml(targets.slice(0, 95))}</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${xml(title)}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#fff"/><text x="24" y="49" fill="#173f32" font-family="system-ui,sans-serif" font-size="28" font-weight="700">${xml(title)}</text><g font-family="system-ui,sans-serif">${items}</g></svg>\n`;
}
const packagePreview = preview("Workspace dependencies", packages.map((name) => ({ label: name, targets: [...packageEdges].filter((edge) => edge.startsWith(`${name}|`)).map((edge) => edge.split("|", 2)[1]) })));
const routePreview = preview("Public routes and imports", routeRows.map((row) => ({ label: row.path, targets: row.imports.map((specifier) => specifier.split("/").at(-1).replace(/\.(?:astro|tsx?|m?js)$/, "")) })));

const document = {
  generatedFrom: "TypeScript AST imports, Astro route frontmatter, and workspace package manifests",
  packages: packages.map((name) => ({ name, description: manifests.get(name).description ?? "", source: `typescript/packages/${name}/package.json` })),
  diagrams: [
    { title: "Workspace dependencies", file: "/docs/diagrams/packages.mmd", image: "/docs/diagrams/packages.svg" },
    { title: "Public routes and data access", file: "/docs/diagrams/routes.mmd", image: "/docs/diagrams/routes.svg" },
  ],
  routes: routeRows,
};
const targets = [[output, `${JSON.stringify(document, null, 2)}\n`], [join(diagramsRoot, "packages.mmd"), packageDiagram], [join(diagramsRoot, "routes.mmd"), routesMermaid], [join(diagramsRoot, "packages.svg"), packagePreview], [join(diagramsRoot, "routes.svg"), routePreview]];
await Promise.all(targets.map(async ([path, content]) => {
  if (check) {
    if (await readFile(path, "utf8").catch(() => "") !== content) {
      console.error(`Stale generated architecture: ${relative(root, path)}`);
      process.exitCode = 1;
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}));
