import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const desktopRoot = join(repoRoot, "desktop");
const stagingRoot = join(desktopRoot, "resources", "staging");
const bundleRoot = join(stagingRoot, "opencodex");
const guiDist = join(repoRoot, "gui", "dist");
const bunBinary = join(repoRoot, "node_modules", "bun", "bin", "bun.exe");

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
copyRequired(join(repoRoot, "package.json"), join(bundleRoot, "package.json"), "package metadata");
copyRequired(join(repoRoot, "bun.lock"), join(bundleRoot, "bun.lock"), "root lockfile");

if (!realBunBinary(bunBinary)) {
  fail(`bundled Bun executable is missing or is only a placeholder: ${bunBinary}`);
}
copyRequired(bunBinary, join(bundleRoot, "runtime", "bun.exe"), "Bun runtime");

const install = Bun.spawnSync(
  [process.execPath, "install", "--production", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"],
  { cwd: bundleRoot, stdout: "inherit", stderr: "inherit" },
);
if (install.exitCode !== 0) fail(`production dependency install failed with exit code ${install.exitCode}`);

// The lockfile is only an installation input; it is not needed at runtime.
rmSync(join(bundleRoot, "bun.lock"), { force: true });

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
