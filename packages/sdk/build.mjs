import { build } from "esbuild";
import ts from "typescript";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(packageDir, "src");
const distDir = join(packageDir, "dist");
const entry = join(sourceDir, "index.ts");
const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  strict: true,
  skipLibCheck: true,
  types: [],
  declaration: true,
  emitDeclarationOnly: true,
  rootDir: resolve(packageDir, ".."),
  outDir: join(distDir, ".declarations"),
};
const program = ts.createProgram([entry], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => packageDir,
      getNewLine: () => "\n",
    }),
  );
}

mkdirSync(distDir, { recursive: true });
const shared = {
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  legalComments: "none",
};
await Promise.all([
  build({ ...shared, format: "esm", outfile: join(distDir, "index.js") }),
  build({ ...shared, format: "cjs", outfile: join(distDir, "index.cjs") }),
]);

// Public types are SDK-owned structural contracts, so declarations never depend on sibling packages.
const result = program.emit(undefined, (_filename, content, _bom, _onError, sourceFiles) => {
  const source = sourceFiles?.[0]?.fileName;
  if (!source) return;
  const path = relative(sourceDir, source);
  if (path.startsWith("..")) return;
  const output = join(distDir, path.replace(/\.ts$/, ".d.ts"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, content);
  writeFileSync(
    output.replace(/\.d\.ts$/, ".d.cts"),
    content.replace(/(from\s+"[^"\n]+)\.js"/g, '$1.cjs"'),
  );
});
if (result.emitSkipped || result.diagnostics.length) throw new Error("SDK declaration emit failed");
