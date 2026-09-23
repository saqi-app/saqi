import console from "node:console";
import { hash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { SWIFT_GRAMMAR, SWIFT_GRAMMAR_WASM_SPECIFIER } from "@binclusive/tree-sitter-swift-wasm";
import ts from "typescript";
import { Language, Parser } from "web-tree-sitter";

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

function readsD1(file, source) {
  const content = file.endsWith(".astro") ? source.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? "" : source;
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "fromD1"
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "CatalogRepository") found = true;
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
const routeSources = await Promise.all(routeFiles.map((file) => readFile(file, "utf8")));
const routeRows = [];
const routeDiagram = ["flowchart LR", '  browser["Reader"]'];
for (const [index, file] of routeFiles.entries()) {
  const source = routeSources[index];
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
  }
  if (readsD1(file, source)) routeDiagram.push('  d1[("Cloudflare D1")]', `  ${id} --> d1`);
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

// SwiftPM's target declarations and Swift import declarations are parsed as syntax trees.
const swiftRoot = join(root, "..", "macos", "SaqiActivityMonitor");
const grammarPath = fileURLToPath(
  import.meta.resolve(SWIFT_GRAMMAR_WASM_SPECIFIER),
);
const grammar = await readFile(grammarPath);
if (hash("sha256", grammar, "hex") !== SWIFT_GRAMMAR.sha256)
  throw new Error("Swift grammar checksum mismatch");
await Parser.init();
const swiftParser = new Parser();
swiftParser.setLanguage(await Language.load(grammarPath));

function swiftAst(file, source) {
  const tree = swiftParser.parse(source);
  if (tree.rootNode.hasError)
    throw new Error(
      `Swift syntax could not be parsed: ${relative(root, file)}`,
    );
  return tree.rootNode;
}

function swiftCalls(node, found = []) {
  if (node.type === "call_expression") found.push(node);
  for (const child of node.namedChildren) swiftCalls(child, found);
  return found;
}

function swiftArgument(call, label) {
  const suffix = call.namedChildren.find(
    (child) => child.type === "call_suffix",
  );
  const args = suffix?.namedChildren.find(
    (child) => child.type === "value_arguments",
  );
  return args?.namedChildren
    .find((child) => child.childForFieldName("name")?.text === label)
    ?.childForFieldName("value");
}

function swiftString(node) {
  if (node?.type !== "line_string_literal")
    throw new Error(
      `Expected a Swift string literal, found ${node?.type ?? "nothing"}`,
    );
  return JSON.parse(node.text);
}

const swiftManifest = join(swiftRoot, "Package.swift");
const swiftManifestAst = swiftAst(
  swiftManifest,
  await readFile(swiftManifest, "utf8"),
);
const manifestCalls = swiftCalls(swiftManifestAst);
const packageCall = manifestCalls.find(
  (call) => call.namedChildren[0]?.text === "Package",
);
if (!packageCall) throw new Error("SwiftPM Package declaration was not found");
const swiftPackageName = swiftString(swiftArgument(packageCall, "name"));
const swiftTargets = manifestCalls
  .filter((call) =>
    [".executableTarget", ".testTarget", ".target"].includes(
      call.namedChildren[0]?.text,
    ),
  )
  .map((call) => {
    const kind = call.namedChildren[0].text.slice(1);
    const name = swiftString(swiftArgument(call, "name"));
    const dependenciesNode = swiftArgument(call, "dependencies");
    if (dependenciesNode && dependenciesNode.type !== "array_literal")
      throw new Error(`Unsupported SwiftPM dependencies for ${name}`);
    const dependencies = dependenciesNode?.namedChildren.map(swiftString) ?? [];
    const pathNode = swiftArgument(call, "path");
    const path = pathNode
      ? swiftString(pathNode)
      : `${kind === "testTarget" ? "Tests" : "Sources"}/${name}`;
    return { name, kind, path, dependencies };
  });
if (!swiftTargets.length) throw new Error("SwiftPM targets were not found");

async function swiftSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return swiftSources(path);
      return entry.name.endsWith(".swift") ? [path] : [];
    }),
  );
  return nested.flat().toSorted();
}

await Promise.all(
  swiftTargets.map(async (target) => {
    const files = await swiftSources(join(swiftRoot, target.path));
    if (!files.length)
      throw new Error(`SwiftPM target has no Swift sources: ${target.name}`);
    const swiftFileImports = await Promise.all(
      files.map(async (file) => {
        const swiftImports = new Set();
        const ast = swiftAst(file, await readFile(file, "utf8"));
        function visit(node) {
          if (node.type === "import_declaration") {
            const module = node.namedChildren.find(
              (child) => child.type === "identifier",
            )?.text;
            if (module) swiftImports.add(module);
          }
          for (const child of node.namedChildren) visit(child);
        }
        visit(ast);
        return [...swiftImports];
      }),
    );
    target.sources = files.length;
    target.imports = [...new Set(swiftFileImports.flat())].toSorted();
  }),
);

const swiftTargetIds = new Map(
  swiftTargets.map((target, index) => [target.name, `swift_target_${index}`]),
);
const swiftFrameworks = [
  ...new Set(swiftTargets.flatMap((target) => target.imports)),
]
  .filter((name) => !swiftTargetIds.has(name))
  .toSorted();
const swiftFrameworkIds = new Map(
  swiftFrameworks.map((name, index) => [name, `swift_framework_${index}`]),
);
const swiftDiagram = [
  "flowchart LR",
  `  swift_package[${JSON.stringify(swiftPackageName)}]`,
  ...swiftTargets.map(
    (target) =>
      `  ${swiftTargetIds.get(target.name)}[${JSON.stringify(`${target.name}: ${target.kind} (${target.sources} files)`)}]`,
  ),
  ...swiftTargets.map(
    (target) => `  swift_package --> ${swiftTargetIds.get(target.name)}`,
  ),
  ...swiftFrameworks.map(
    (name) => `  ${swiftFrameworkIds.get(name)}[${JSON.stringify(name)}]`,
  ),
  ...swiftTargets.flatMap((target) =>
    target.dependencies.map((dependency) => {
      const id = swiftTargetIds.get(dependency);
      if (!id)
        throw new Error(`Unknown SwiftPM target dependency: ${dependency}`);
      return `  ${swiftTargetIds.get(target.name)} --> ${id}`;
    }),
  ),
  ...swiftTargets.flatMap((target) =>
    target.imports
      .filter((name) => swiftFrameworkIds.has(name))
      .map(
        (name) =>
          `  ${swiftTargetIds.get(target.name)} --> ${swiftFrameworkIds.get(name)}`,
      ),
  ),
]
  .join("\n")
  .concat("\n");
const swiftPreview = preview(
  "macOS target dependencies",
  swiftTargets.map((target) => ({
    label: target.name,
    targets: [
      ...target.dependencies,
      ...target.imports.filter((name) => swiftFrameworkIds.has(name)),
    ],
  })),
);

const document = {
  generatedFrom: "TypeScript AST imports and D1 calls, Astro route frontmatter, workspace package manifests, and parsed SwiftPM and Swift syntax trees",
  packages: packages.map((name) => ({ name, description: manifests.get(name).description ?? "", source: `typescript/packages/${name}/package.json` })),
  diagrams: [
    { title: "Workspace dependencies", file: "/docs/diagrams/packages.mmd", image: "/docs/diagrams/packages.svg" },
    { title: "Public routes and data access", file: "/docs/diagrams/routes.mmd", image: "/docs/diagrams/routes.svg" },
    { title: "macOS targets and imports", file: "/docs/diagrams/macos.mmd", image: "/docs/diagrams/macos.svg" },
  ],
  routes: routeRows,
  macos: { name: swiftPackageName, source: "macos/SaqiActivityMonitor/Package.swift", targets: swiftTargets },
};
const targets = [[output, `${JSON.stringify(document, null, 2)}\n`], [join(diagramsRoot, "packages.mmd"), packageDiagram], [join(diagramsRoot, "routes.mmd"), routesMermaid], [join(diagramsRoot, "macos.mmd"), swiftDiagram], [join(diagramsRoot, "packages.svg"), packagePreview], [join(diagramsRoot, "routes.svg"), routePreview], [join(diagramsRoot, "macos.svg"), swiftPreview]];
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
