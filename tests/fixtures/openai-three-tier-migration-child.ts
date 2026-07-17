import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [opencodexHome, codexHome] = Bun.argv.slice(2);
if (!opencodexHome || !codexHome) throw new Error("migration child requires two home paths");
mkdirSync(opencodexHome, { recursive: true, mode: 0o700 });
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
process.env.OPENCODEX_HOME = opencodexHome;
process.env.CODEX_HOME = codexHome;

const original = JSON.stringify({
  port: 10100,
  defaultProvider: "chatgpt",
  providers: {
    chatgpt: {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    },
  },
  codexAccounts: [{ id: "fixture-pool", email: "pool@example.test", isMain: false }],
}, null, 2) + "\n";
const configPath = join(opencodexHome, "config.json");
writeFileSync(configPath, original, { mode: 0o600 });
chmodSync(configPath, 0o600);

const [{ loadConfig }, { runOpenAiTierStartupMigration }, { projectOpenAiTierMigration }] = await Promise.all([
  import("../../src/config"),
  import("../../src/providers/openai-tier-startup"),
  import("../../src/providers/openai-tiers"),
]);

const first = runOpenAiTierStartupMigration(loadConfig());
const firstBytes = readFileSync(configPath, "utf8");
const backupPath = `${configPath}.pre-openai-tiers-v1.bak`;
const backupBytes = readFileSync(backupPath, "utf8");
const secondProjection = projectOpenAiTierMigration(loadConfig());
runOpenAiTierStartupMigration(loadConfig());
const secondBytes = readFileSync(configPath, "utf8");

copyFileSync(backupPath, configPath);
chmodSync(configPath, 0o600);
const restoredBytes = readFileSync(configPath, "utf8");
const restoredLegacy = loadConfig();
const backupBeforeRemigration = readFileSync(backupPath, "utf8");
const remigrated = runOpenAiTierStartupMigration(restoredLegacy);
const remigratedBytes = readFileSync(configPath, "utf8");
const backupAfterRemigration = readFileSync(backupPath, "utf8");

process.stdout.write(JSON.stringify({
  backupMatchesOriginal: backupBytes === original,
  backupMode: statSync(backupPath).mode & 0o777,
  firstProviderIds: Object.keys(first.providers),
  firstDefaultProvider: first.defaultProvider,
  hiddenLegacy: !Object.hasOwn(first.providers, "chatgpt"),
  marker: first.openaiProviderTierVersion,
  secondIdempotent: firstBytes === secondBytes && secondProjection.changed === false,
  restoredByteIdentity: restoredBytes === original,
  restoredLegacyParse: restoredLegacy.defaultProvider === "chatgpt"
    && Object.hasOwn(restoredLegacy.providers, "chatgpt")
    && restoredLegacy.openaiProviderTierVersion === undefined,
  backupReused: backupBeforeRemigration === backupAfterRemigration && backupAfterRemigration === original,
  remigrated: remigratedBytes === firstBytes
    && remigrated.defaultProvider === "openai-multi"
    && !Object.hasOwn(remigrated.providers, "chatgpt")
    && projectOpenAiTierMigration(remigrated).changed === false,
}) + "\n");
