export const CODEX_SYNTHETIC_VERSION = "0.158.0-alpha.2.1";
export const SYNTHETIC_INSTRUCTIONS = "This is a synthetic NetNavr engineering test. Return only the requested marker, alpha or beta. No tools.";
export const CODEX_SYNTHETIC_CONFIG = Object.freeze({
  "features.hooks": false, "features.codex_hooks": false, "features.apps": false,
  "features.shell_tool": false, "features.unified_exec": false, "features.multi_agent": false,
  "features.web_search_request": false, "web_search": "disabled", "notify": [],
  "project_doc_max_bytes": 0, "developer_instructions": SYNTHETIC_INSTRUCTIONS,
  "skills.include_instructions": false, "include_apps_instructions": false,
  "skills.bundled.enabled": false, "features.js_repl": false, "features.code_mode": false,
  "features.code_mode_host": false, "features.code_mode_only": false, "features.search_tool": false,
  "features.memories": false, "features.tool_search": false, "features.tool_suggest": false,
  "features.in_app_browser": false, "features.browser_use": false, "features.computer_use": false,
  "features.image_generation": false, "features.imagegenext": false, "features.goals": false,
  "features.responses_websockets": false, "features.responses_websockets_v2": false,
  "agents.enabled": false, "tools.experimental_request_user_input.enabled": false,
  "include_environment_context": false, "include_permissions_instructions": false,
  "include_collaboration_mode_instructions": false, "analytics.enabled": false,
  "features.respect_system_proxy": false,
});
export function assertCodexConfig(config, requirements, layers) {
  if (!config || typeof config !== "object" || !requirements || typeof requirements !== "object") throw new Error("INVALID_PREFLIGHT");
  for (const [key, expected] of Object.entries(CODEX_SYNTHETIC_CONFIG)) {
    let actual = key.split(".").reduce((obj, part) => obj?.[part], config);
    // This pinned protocol's ToolsV2 omits this field. Only its explicit
    // session layer can prove it; unknown/project/managed layers fail closed.
    if (key === "tools.experimental_request_user_input.enabled" && actual === undefined && Array.isArray(layers)) {
      const active = layers.filter((layer) => !layer.disabledReason);
      if (active.some((layer) => !["user", "sessionFlags"].includes(layer.name?.type) &&
        !(layer.name?.type === "system" && layer.config && Object.keys(layer.config).length === 0))) {
        const error = new Error("MANAGED_POLICY_REQUIRES_REVIEW");
        error.layerSummary = active.map((layer) => ({ type: ["user", "sessionFlags", "system", "packagedDefaults", "mdm", "enterpriseManaged", "project"].includes(layer.name?.type) ? layer.name.type : "other", keyCount: Object.keys(layer.config ?? {}).length }));
        throw error;
      }
      const users = active.filter((layer) => layer.name.type === "user");
      if (users.some((layer) => Object.keys(layer.config ?? {}).some((k) => !["forced_login_method", "cli_auth_credentials_store"].includes(k)))) throw new Error("CUSTOMIZATION_NOT_ALLOWED");
      const flags = active.filter((layer) => layer.name.type === "sessionFlags");
      if (flags.length === 1) actual = flags[0].config?.tools?.experimental_request_user_input?.enabled;
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const error = new Error("EFFECTIVE_POLICY_MISMATCH"); error.policyKey = key; throw error;
    }
  }
  if (!Object.hasOwn(requirements, "requirements") || (requirements.requirements !== null &&
    (typeof requirements.requirements !== "object" || Array.isArray(requirements.requirements)))) throw new Error("INVALID_PREFLIGHT");
  const restrictions = Object.entries(requirements.requirements ?? {}).filter(([, v]) => v !== null);
  if (restrictions.some(([k, v]) => k !== "allowedLoginMethods" || JSON.stringify(v) !== '["chatgpt"]')) {
    throw new Error("MANAGED_POLICY_REQUIRES_REVIEW");
  }
  for (const key of ["mcp_servers", "plugins", "hooks", "model_providers"]) {
    if (config[key] != null && Object.keys(config[key]).length) { const e = new Error("CUSTOMIZATION_NOT_ALLOWED"); e.control = key; throw e; }
  }
  for (const key of ["instructions", "model_instructions_file", "experimental_compact_prompt_file",
    "model_catalog_json", "openai_base_url", "chatgpt_base_url", "experimental_thread_store_endpoint"]) {
    if (key === "chatgpt_base_url" && config[key] === "https://chatgpt.com/backend-api/") continue;
    if (config[key] != null) { const e = new Error("CUSTOMIZATION_NOT_ALLOWED"); e.control = key; throw e; }
  }
  if (config.model_provider != null && config.model_provider !== "openai") throw new Error("OFFICIAL_PROVIDER_REQUIRED");
}
export function assertEmptyContext(started, skills) {
  if (!Array.isArray(started?.instructionSources) || started.instructionSources.length !== 0 ||
      !Array.isArray(started?.thread?.environments) || started.thread.environments.length !== 0 ||
      !Array.isArray(skills?.data) || skills.data.length !== 1 ||
      !Array.isArray(skills.data[0]?.skills) || skills.data[0].skills.length !== 0 ||
      !Array.isArray(skills.data[0]?.errors) || skills.data[0].errors.length !== 0) throw new Error("CONTEXT_NOT_EMPTY");
}
export function parseSyntheticCompletion(event, threadId, turnId, marker) {
  if (event?.method !== "turn/completed" || event.params?.threadId !== threadId || event.params?.turn?.id !== turnId) throw new Error("RESPONSE_ID_MISMATCH");
  const turn = event.params.turn;
  if (turn.status === "interrupted") return { state: "CANCELLED" };
  if (turn.status !== "completed" || turn.error != null) return { state: "PROVIDER_FAILED" };
  const items = turn.items;
  if (!Array.isArray(items) || items.some((i) => !["agentMessage", "reasoning"].includes(i?.type))) throw new Error("UNEXPECTED_RESPONSE_ITEM");
  const messages = items.filter((i) => i.type === "agentMessage");
  if (messages.length !== 1 || messages[0].text !== marker || !["alpha", "beta"].includes(marker)) throw new Error("INVALID_MARKER_RESPONSE");
  return { state: "COMPLETED", marker, threadId, turnId };
}
