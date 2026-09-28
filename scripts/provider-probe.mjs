import { ProviderProbe, providerBounds } from "../packages/provider-probe/src/index.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "status";
const provider = args[1] ?? "all";
const auth = args.slice(2);
if (!['status', 'bounds', 'run', 'cancel'].includes(command)
    || !['all', 'codex', 'claude'].includes(provider)
    || auth.some((value) => value !== '--check-auth')
    || (command !== 'status' && auth.length)) {
  console.log(JSON.stringify({ state: "INVALID_ARGUMENT", usage: "provider-probe [status|bounds|run|cancel] [all|codex|claude] [--check-auth]" }));
  process.exitCode = 2;
} else {
  const probe = new ProviderProbe();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const providers = provider === "all" ? ["codex", "claude"] : [provider];
  const results = [];
  try {
    for (const name of providers) {
      results.push(command === "status" ? await probe.status(name, { checkAuth: auth.includes("--check-auth"), signal: abort.signal })
        : command === "cancel" ? probe.cancel() : providerBounds(name));
    }
    console.log(JSON.stringify({ command, modelRequest: false, results }, null, 2));
    if (command === "run") process.exitCode = 3;
  } catch {
    // Official tool diagnostics can contain secrets. Only stable local codes escape.
    console.log(JSON.stringify({ state: "PROBE_FAILED", modelRequest: false }));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
