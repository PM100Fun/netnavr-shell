import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { arch, platform, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_API_VERSION, CORE_SCHEMA_VERSION } from "@netnavr/core/contract";
import { FIXTURE_CONTRACT_VERSION, FIXTURE_SCHEMA_VERSION } from "@netnavr/core/fixture-contract";
import { SHELL_PROTOCOL_VERSION } from "../packages/protocol/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pairs = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < pairs.length; i += 2) {
  if (!["--out", "--candidate", "--artifact", "--core-source"].includes(pairs[i]) || !pairs[i + 1] || options.has(pairs[i])) {
    throw new Error("Usage: candidate:prepare -- --out ABSOLUTE_NEW_JSON --core-source ABSOLUTE_CLEAN_CORE --candidate app-0.1.0-alpha.N [--artifact ABSOLUTE_PATH]");
  }
  options.set(pairs[i], pairs[i + 1]);
}
const output = options.get("--out");
const candidate = options.get("--candidate");
if (!output || !path.isAbsolute(output) || !/^app-0\.1\.0-alpha\.[1-9]\d*$/.test(candidate ?? "")) throw new Error("Candidate identity and an absolute output path are required");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 }).trim();
if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Candidate source must be a clean committed checkout");
const sourceSha = git("rev-parse", "HEAD");
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lockBytes = await readFile(path.join(root, "package-lock.json"));
const lock = JSON.parse(lockBytes);
if (lock.packages[""]?.version !== metadata.version) throw new Error("Shell component version and lock disagree");
const declaredAppVersion = /^extraMetadata:\r?\n\s{2}version:\s*["']?([^\s"']+)/m.exec(await readFile(path.join(root, "electron-builder.yml"), "utf8"))?.[1];
if (declaredAppVersion !== candidate.slice(4)) throw new Error("Candidate App version differs from builder metadata");
const corePin = metadata.devDependencies["@netnavr/core"];
const match = /^git\+https:\/\/github\.com\/PM100Fun\/netnavr-core\.git#([a-f0-9]{40})$/.exec(corePin ?? "");
if (!match || lock.packages["node_modules/@netnavr/core"]?.resolved !== corePin) throw new Error("Core must have the same full Git SHA in package and lock");
const coreMetadata = JSON.parse(await readFile(path.join(root, "node_modules/@netnavr/core/package.json"), "utf8"));
const coreSource = options.get("--core-source");
if (!coreSource || !path.isAbsolute(coreSource)) throw new Error("Exact Core source checkout is required to record its lockfile");
const coreGit = (...args) => execFileSync("git", args, { cwd: coreSource, encoding: "utf8", maxBuffer: 1024 * 1024 }).trim();
if (coreGit("rev-parse", "HEAD") !== match[1] || coreGit("status", "--porcelain", "--untracked-files=normal")) throw new Error("Core source must be clean and match the consuming pin");
if (JSON.parse(await readFile(path.join(coreSource, "package.json"), "utf8")).version !== coreMetadata.version) throw new Error("Installed Core version differs from source");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
let artifact = null;
if (options.has("--artifact")) {
  const requested = options.get("--artifact");
  if (!path.isAbsolute(requested)) throw new Error("Artifact path must be absolute");
  const info = await lstat(requested);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("Artifact must be a regular file or directory");
  const canonicalRoot = await realpath(requested);
  const entries = [];
  const walk = async (item, relative) => {
    const stat = await lstat(item);
    if (stat.isSymbolicLink()) {
      const target = await realpath(item);
      const boundary = path.relative(canonicalRoot, target);
      if (boundary.startsWith(`..${path.sep}`) || boundary === ".." || path.isAbsolute(boundary)) throw new Error("Artifact link escapes its directory");
      entries.push({ path: relative, type: "link", target: await readlink(item) });
    } else if (stat.isDirectory()) {
      entries.push({ path: relative, type: "directory", mode: stat.mode & 0o777 });
      for (const name of (await readdir(item)).sort()) await walk(path.join(item, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      entries.push({ path: relative, type: "file", mode: stat.mode & 0o777, bytes: stat.size, sha256: await fileHash(item) });
    } else throw new Error("Unsupported artifact entry");
  };
  if (info.isDirectory()) await walk(requested, "");
  artifact = info.isFile()
    ? { path: requested, kind: "file", bytes: info.size, sha256: await fileHash(requested) }
    : { path: requested, kind: "directory", inventorySha256: sha256(JSON.stringify(entries)), entries };
}
const manifest = {
  manifestVersion: 1, candidate, productVersion: "0.1", appVersion: candidate.slice(4),
  stage: artifact ? "BUILT_UNVERIFIED" : "SOURCE_PREPARATION_ONLY", createdAt: new Date().toISOString(),
  source: { shell: { repository: metadata.repository, sha: sourceSha, componentVersion: metadata.version, lockSha256: sha256(lockBytes) }, core: { repository: coreMetadata.repository, sha: match[1], componentVersion: coreMetadata.version, lockSha256: sha256(await readFile(path.join(coreSource, "package-lock.json"))) } },
  protocols: { coreApi: CORE_API_VERSION, productSchema: CORE_SCHEMA_VERSION, fixture: FIXTURE_CONTRACT_VERSION, fixtureSchema: FIXTURE_SCHEMA_VERSION, shellLegacyWebSocket: SHELL_PROTOCOL_VERSION },
  upstream: { t3: "de251fc2971a884cb5b1305ba4daf309dc8cccb0", visual: "dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5", selectedFiles: "NOTICE" },
  build: { platform: platform(), architecture: arch(), osRelease: release(), node: process.version, npm: /(?:^|\s)npm\/([^\s]+)/.exec(process.env.npm_config_user_agent ?? "")?.[1] ?? "NOT_RECORDED", electron: lock.packages["node_modules/electron"]?.version },
  fixture: { namespace: "product-0.1-engineering/fixture-v1", data: "synthetic-markers-only", commandPersistence: "session-only" },
  artifact, signing: { state: "NOT_VERIFIED", notarization: "NOT_EXECUTED" },
  installation: "NOT_EXECUTED", realProvider: "NOT_VERIFIED", manualAcceptance: "NOT_EXECUTED",
};
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ candidate, stage: manifest.stage, manifestPath: output, manifestSha256: await fileHash(output) }));
