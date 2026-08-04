import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const desktopRoot = join(repoRoot, "desktop");
const stagingRoot = join(desktopRoot, "resources", "staging");
const bundleRoot = join(stagingRoot, "opencodex");
const guiDist = join(repoRoot, "gui", "dist");
const bunBinary = join(repoRoot, "node_modules", "bun", "bin", "bun.exe");
const sourceNodeModules = join(repoRoot, "node_modules");
const bundleNodeModules = join(bundleRoot, "node_modules");

function fail(message: string): never {
  throw new Error(`[desktop-resources] ${message}`);
}

function copyRequired(source: string, target: string, label: string): void {
  if (!existsSync(source)) fail(`${label} not found: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    filter: candidate => basename(candidate).toLowerCase() !== "agents.md",
  });
}

function copyDesktopPackageMetadata(source: string, target: string): void {
  const metadata = JSON.parse(readFileSync(source, "utf8")) as {
    dependencies?: Record<string, string>;
    [key: string]: unknown;
  };
  if (metadata.dependencies) {
    delete metadata.dependencies.bun;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function packagePath(root: string, packageName: string): string {
  return packageName.startsWith("@")
    ? join(root, ...packageName.split("/"))
    : join(root, packageName);
}

function findInstalledPackage(packageName: string, fromDirectory: string): string | null {
  let current = fromDirectory;
  while (true) {
    const candidate = packagePath(join(current, "node_modules"), packageName);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const rootCandidate = packagePath(sourceNodeModules, packageName);
  return existsSync(join(rootCandidate, "package.json")) ? rootCandidate : null;
}

function readPackageDependencies(packageDirectory: string): string[] {
  const packageJson = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ];
}

function copyProductionDependencies(rootPackageJson: string): void {
  const rootMetadata = JSON.parse(readFileSync(rootPackageJson, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const queue = Object.keys(rootMetadata.dependencies ?? {})
    .filter(dependency => dependency !== "bun")
    .map(dependency => ({ dependency, fromDirectory: repoRoot }));
  const copied = new Set<string>();

  for (let index = 0; index < queue.length; index += 1) {
    const { dependency, fromDirectory } = queue[index];
    const source = findInstalledPackage(dependency, fromDirectory);
    if (!source) fail(`production dependency is not installed: ${dependency}`);
    const relativePackagePath = relative(sourceNodeModules, source);
    if (relativePackagePath.startsWith("..")) fail(`dependency resolved outside node_modules: ${dependency}`);
    if (copied.has(relativePackagePath)) continue;

    const target = join(bundleNodeModules, relativePackagePath);
    copyRequired(source, target, `production dependency ${dependency}`);
    copied.add(relativePackagePath);

    for (const child of readPackageDependencies(source)) {
      if (child === "bun") continue;
      const childSource = findInstalledPackage(child, source);
      if (childSource) {
        queue.push({ dependency: child, fromDirectory: source });
      }
    }
  }
}

function listFiles(root: string, current = root): string[] {
  const entries = readdirSync(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, absolute));
    else files.push(relative(root, absolute).replaceAll("\\", "/"));
  }
  return files.sort();
}

function realBunBinary(path: string): boolean {
  return existsSync(path) && statSync(path).isFile() && statSync(path).size > 1_000_000;
}

rmSync(stagingRoot, { recursive: true, force: true });
// Electron-builder writes its unpacked output beside the TypeScript output by
// default in older runs. Remove only these generated paths before collecting
// `dist/**/*`, so a failed build can never be nested into the next app.asar.
rmSync(join(desktopRoot, "dist", "win-unpacked"), { recursive: true, force: true });
rmSync(join(desktopRoot, "dist", "builder-debug.yml"), { force: true });
mkdirSync(bundleRoot, { recursive: true });

copyRequired(join(repoRoot, "src"), join(bundleRoot, "src"), "backend source");
copyRequired(guiDist, join(bundleRoot, "gui", "dist"), "GUI build");
copyDesktopPackageMetadata(join(repoRoot, "package.json"), join(bundleRoot, "package.json"));

if (!realBunBinary(bunBinary)) {
  fail(`bundled Bun executable is missing or is only a placeholder: ${bunBinary}`);
}
copyRequired(bunBinary, join(bundleRoot, "runtime", "bun.exe"), "Bun runtime");
copyProductionDependencies(join(repoRoot, "package.json"));

const files = listFiles(bundleRoot);
const manifest = {
  format: 1,
  generatedAt: new Date().toISOString(),
  files,
  fileCount: files.length,
  forbidden: [".git", "questions", "reference", "todolist.md", "*.log", "*.pem", "*.pfx", "*.key", "*.env"],
};
writeFileSync(join(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`[desktop-resources] prepared ${files.length} files under ${bundleRoot}`);
