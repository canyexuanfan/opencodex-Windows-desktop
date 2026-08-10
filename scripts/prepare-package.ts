import { chmod, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateCompatibilityVersionManifest } from "./generate-compatibility-version";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function repoPath(...parts: string[]): string {
  return path.join(repoRoot, ...parts);
}

async function chmodRequired(filePath: string, mode: number): Promise<void> {
  await chmod(filePath, mode);
}

async function chmodTreeExecutable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await chmodTreeExecutable(fullPath);
      continue;
    }
    if (entry.isFile()) await chmod(fullPath, 0o755);
  }
}

async function assertRegularFile(filePath: string): Promise<void> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`expected regular package file: ${filePath}`);
  }
}

// The compatibility identity must be generated from the final tracked working
// tree before packaging. The output itself stays untracked to avoid self-reference.
generateCompatibilityVersionManifest(repoRoot);

for (const file of [
  repoPath("bin", "opencodex.mjs"),
  repoPath("bin", "opencodex.cmd"),
  repoPath("bin", "package-main.mjs"),
  repoPath("scripts", "install-bun-runtime.cjs"),
]) {
  await assertRegularFile(file);
  await chmodRequired(file, 0o755);
}

await chmodTreeExecutable(repoPath("scripts", "bun-runtime"));
