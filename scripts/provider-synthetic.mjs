import { CodexSyntheticProvider } from "../packages/provider-probe/src/index.mjs";
const [mode = "preflight", ...extra] = process.argv.slice(2);
const options = { executable: process.env.NETNAVR_SYNTHETIC_CODEX, dedicatedHome: process.env.NETNAVR_SYNTHETIC_HOME, evidenceRoot: process.env.NETNAVR_SYNTHETIC_EVIDENCE };
if (extra.length || !["preflight", "alpha", "beta"].includes(mode)) {
  console.log(JSON.stringify({ state: "INVALID_ARGUMENT", modelRequest: false })); process.exitCode = 2;
} else if (Object.values(options).some((value) => !value)) {
  console.log(JSON.stringify({ state: "NOT_CONFIGURED", modelRequest: false })); process.exitCode = 3;
} else {
  const provider = new CodexSyntheticProvider(options);
  const cancel = () => provider.cancel();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const result = mode === "preflight" ? await provider.preflight() : await provider.run(mode);
    console.log(JSON.stringify(result));
    if (!["CONTEXT_VERIFIED", "COMPLETED", "CANCELLED"].includes(result.state)) process.exitCode = 1;
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
