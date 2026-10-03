/** Offline additive integration. Never modifies or deploys the supplied core. */
import { cpSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2]) throw new Error("Supply a local chippiv2 checkout with its existing installed dependencies. No installation, credentials or deployment are performed.");
const core = resolve(process.argv[2]);
const host = join(core, "apps/web");
if (!existsSync(join(host, "node_modules/.bin/vitest"))) throw new Error("Existing core dependencies are required");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const scratch = join(moduleRoot, ".local", `fixture-${stamp}`);
mkdirSync(scratch, { recursive: true });
cpSync(join(host, "convex"), join(scratch, "convex"), { recursive: true });
cpSync(join(moduleRoot, "convex"), join(scratch, "convex"), { recursive: true });
cpSync(join(moduleRoot, "tests"), join(scratch, "tests"), { recursive: true });
cpSync(join(moduleRoot, "integration"), join(scratch, "integration"), { recursive: true });
mkdirSync(join(scratch, "scripts"));
cpSync(join(host, "scripts/convex-codegen-offline.mjs"), join(scratch, "scripts/convex-codegen-offline.mjs"));
symlinkSync(join(host, "node_modules"), join(scratch, "node_modules"), "dir");
symlinkSync(join(host, "lib"), join(scratch, "lib"), "dir");
writeFileSync(join(scratch, "package.json"), '{"private":true,"type":"module"}\n');
const bridge = JSON.parse(readFileSync(join(moduleRoot, "integration/bridge.json"), "utf8"));
const edit = (file, transform) => {
  const target = join(scratch, "convex", file);
  writeFileSync(target, transform(readFileSync(target, "utf8")));
};
function insert(source, anchor, text) {
  if (!source.includes(anchor)) throw new Error(`Core integration anchor is unavailable: ${anchor}. Review compatibility; never weaken checks.`);
  return source.replace(anchor, text + anchor);
}
edit("schema.ts", s => insert('import { verticalTables } from "../integration/schema-tables"\n' + s, '  properties: defineTable(', '  ...verticalTables,\n'));
edit("tenant.ts", s => insert(s, '  | "properties"', bridge.scopedTables.map(n => `  | "${n}"\n`).join("")));
edit("workforce.ts", s => {
  s = bridge.imports + s;
  s = insert(s, '                    "tours",', bridge.operations.map(n => `                    "${n}",\n`).join(""));
  s = insert(s, ' : ({ operation }))', bridge.catalog);
  return insert(s, '    if (operation === "organizationLeads") {', bridge.handlers);
});
writeFileSync(join(scratch, "vitest.config.mts"), 'import { defineConfig } from "vitest/config";\nexport default defineConfig({resolve:{alias:{"@":'+JSON.stringify(scratch)+'}},test:{environment:"node",include:["tests/**/*.test.ts"],maxWorkers:1}});\n');
// Whitelist env: module fixtures receive no model/storage/email/calendar credentials.
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, NODE_ENV: "test" };
function run(binary, args, label) {
  const result = spawnSync(binary, args, { cwd: scratch, env, encoding: "utf8", maxBuffer: 8*1024*1024 });
  writeFileSync(join(scratch, `${label}.log`), (result.stdout ?? "") + (result.stderr ?? ""));
  console.log(`${label}: ${result.status === 0 ? "passed" : "failed"}`);
  return result.status ?? 1;
}
const codegen = run(process.execPath, ["scripts/convex-codegen-offline.mjs"], "offline-codegen");
const types = codegen ? null : run(join(host, "node_modules/.bin/tsc"), ["--noEmit", "-p", "convex"], "convex-types");
const tests = codegen ? null : run(join(host, "node_modules/.bin/vitest"), ["run", "--config", "vitest.config.mts", "--reporter=default", "--reporter=json", "--outputFile=tests.json"], "module-tests");
const files = readdirSync(join(moduleRoot,"convex")).filter(n=>n.endsWith(".ts"));
writeFileSync(join(scratch,"receipt.json"), JSON.stringify({at:new Date().toISOString(),offlineCodegen:codegen,typecheck:types,testExit:tests,mode:"isolated Convex handler integration against supplied local core",credentials:"none inherited",deployment:false,modelCalls:0,liveBusinessEffects:0,sourceHashes:Object.fromEntries(files.map(n=>[n,createHash("sha256").update(readFileSync(join(moduleRoot,"convex",n))).digest("hex")]))},null,2)+"\n");
console.log(`Evidence retained in .local/fixture-${stamp}`);
process.exitCode = codegen || types || tests || 0;
