#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_PROVIDER = "sub2api";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_KEY_ENV = "SUB2API_API_KEY";
const GATEWAY_UNIT = "openclaw-gateway";
const GATEWAY_XDG_RUNTIME_DIR = "/run/user/0";

const USAGE = `Usage: node scripts/sync-sub2api-models.mjs [options]

Keep an OpenClaw instance's model config in lockstep with the model allowed by
its Sub2API API key group.

Options:
  --home <dir>        OpenClaw home (default: $OPENCLAW_HOME or ~/.openclaw)
  --provider <name>   provider key inside models.providers (default: sub2api)
  --base-url <url>    override provider baseUrl
  --key-env <NAME>    env var holding the key (default: provider.apiKey.id, else SUB2API_API_KEY)
  --dry-run           print the plan, write nothing
  --check             exit 1 if config already matches, 0 if it does not; write nothing
  --json              machine-readable output on stdout
  --restart           restart openclaw-gateway after a successful write
  --timeout-ms <n>    HTTP timeout (default 5000)
  --help              show this help

Exit codes: 0 ok/changed, 1 --check mismatch, 2 discovery or IO failure.`;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function now() {
  return new Date().toISOString();
}

function printJson(data) {
  console.log(JSON.stringify(data));
}

function isFlag(value) {
  return value === "true" || value === true;
}

function expandHome(input) {
  if (typeof input !== "string" || input === "") return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
  );
}

function backupStamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function detectIndent(raw) {
  if (!raw) return "  ";
  const match = raw.match(/^[ \t]+(?=")/m);
  return match ? match[0] : "  ";
}

function serializeDoc(doc, raw) {
  const body = JSON.stringify(doc, null, detectIndent(raw));
  if (!raw) return `${body}\n`;
  return raw.endsWith("\n") ? `${body}\n` : body;
}

async function readJsonFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { exists: false, raw: "", doc: {} };
    throw err;
  }
  let doc;
  try {
    doc = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON in ${filePath}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`unexpected JSON document in ${filePath} (expected an object)`);
  }
  return { exists: true, raw, doc };
}

async function fileMode(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.mode & 0o777;
  } catch {
    return 0o600;
  }
}

// Config carries credentials, so never leave it group/world readable. Restrictive
// owner-only modes (e.g. 0400) are preserved, anything else becomes 0600.
function secureMode(mode) {
  const masked = mode & 0o600;
  return masked === 0 ? 0o600 : masked;
}

async function writeAtomic(filePath, content, mode) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  const handle = await fs.open(tmp, "w", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, filePath);
}

async function backupFile(filePath, stamp) {
  const target = `${filePath}.bak-${stamp}`;
  await fs.copyFile(filePath, target);
  await fs.chmod(target, secureMode(await fileMode(filePath)));
  return target;
}

async function getJson(url, key, timeoutMs) {
  const headers = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason =
      err?.name === "TimeoutError"
        ? `request timed out after ${timeoutMs}ms`
        : `request failed: ${err?.message || err}`;
    throw new Error(`${url}: ${reason}`);
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  return { status: response.status, text };
}

function validateKeyGroup(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "key-group body is not an object" };
  }
  if (body.schema_version !== 1) {
    return { ok: false, reason: "key-group schema_version is not 1" };
  }
  if (body.object !== "sub2api.key_group") {
    return { ok: false, reason: "key-group object is not sub2api.key_group" };
  }
  const key = body.key;
  const group = body.group;
  if (!group || typeof group !== "object") {
    return { ok: false, reason: "key-group body has no group" };
  }
  if (group.status !== "active") {
    return { ok: false, reason: `group status is ${JSON.stringify(group.status)}` };
  }
  if (!key || typeof key !== "object" || key.group_id !== group.id) {
    return { ok: false, reason: "key group_id does not match group id" };
  }
  if (!Array.isArray(body.models) || body.models.length !== 1) {
    return { ok: false, reason: "key group must expose exactly one model" };
  }
  const model = body.models[0];
  if (!model || typeof model !== "object" || typeof model.id !== "string" || model.id.trim() === "") {
    return { ok: false, reason: "key group model id is missing" };
  }
  return { ok: true, model, revision: body.revision, group };
}

async function tryKeyGroup(baseUrl, key, timeoutMs) {
  const url = `${baseUrl}/sub2api/key-group`;
  const { status, text } = await getJson(url, key, timeoutMs);
  if (status === 404 || status === 405 || status === 501) {
    return { ok: false, reason: `key-group endpoint unavailable (http ${status})` };
  }
  if (status !== 200) {
    return { ok: false, reason: `key-group endpoint returned http ${status}` };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: "key-group body is not valid JSON" };
  }
  return validateKeyGroup(body);
}

function validateModelList(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "/models body is not an object" };
  }
  if (body.object !== "list" || !Array.isArray(body.data)) {
    return { ok: false, reason: "/models body is not an OpenAI-style list" };
  }
  const ids = [];
  for (const item of body.data) {
    const id = typeof item === "string" ? item : item?.id;
    if (typeof id === "string" && id.trim() !== "" && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) {
    return { ok: false, reason: "/models returned no usable model ids" };
  }
  if (ids.length > 1) {
    return {
      ok: false,
      reason: `ambiguous model list: ${ids.length} models available (${ids.join(", ")})`,
    };
  }
  return { ok: true, model: { id: ids[0] } };
}

async function tryModelList(baseUrl, key, timeoutMs) {
  const url = `${baseUrl}/models`;
  const { status, text } = await getJson(url, key, timeoutMs);
  if (status !== 200) {
    return { ok: false, reason: `/models returned http ${status}` };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: "/models body is not valid JSON" };
  }
  return validateModelList(body);
}

async function discoverModel({ baseUrl, key, timeoutMs }) {
  const tier1 = await tryKeyGroup(baseUrl, key, timeoutMs);
  if (tier1.ok) {
    return { source: "key-group", model: tier1.model, revision: tier1.revision };
  }
  const tier2 = await tryModelList(baseUrl, key, timeoutMs);
  if (tier2.ok) {
    return { source: "models", model: tier2.model, revision: undefined, tier1Reason: tier1.reason };
  }
  throw new Error(
    `model discovery failed: ${tier2.reason} (key-group tier: ${tier1.reason})`,
  );
}

function buildModelEntry(model) {
  const entry = {
    id: model.id,
    name: model.id,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 65536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    api: "openai-completions",
    reasoning: false,
  };
  const contextWindow = model.context_window ?? model.contextWindow;
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    entry.contextWindow = contextWindow;
  }
  const maxTokens = model.max_tokens ?? model.maxTokens;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
    entry.maxTokens = maxTokens;
  }
  if (typeof model.reasoning === "boolean") entry.reasoning = model.reasoning;
  if (Array.isArray(model.input) && model.input.length > 0) {
    const input = model.input.filter((value) => typeof value === "string" && value !== "");
    if (input.length > 0) entry.input = input;
  }
  return entry;
}

function planOpenclawDoc(doc, provider, entry) {
  const next = structuredClone(doc);
  const qualified = `${provider}/${entry.id}`;

  next.models = ensureObject(next.models);
  next.models.providers = ensureObject(next.models.providers);
  next.models.providers[provider] = ensureObject(next.models.providers[provider]);
  next.models.providers[provider].models = [entry];

  next.agents = ensureObject(next.agents);
  next.agents.defaults = ensureObject(next.agents.defaults);
  next.agents.defaults.models = { [qualified]: { alias: entry.id } };
  const modelConfig = ensureObject(next.agents.defaults.model);
  modelConfig.primary = qualified;
  modelConfig.fallbacks = [];
  next.agents.defaults.model = modelConfig;

  return next;
}

function findProviderCatalog(doc, provider) {
  const candidates = [
    doc?.models?.providers?.[provider],
    doc?.providers?.[provider],
    doc?.[provider],
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && Array.isArray(candidate.models)) {
      return candidate;
    }
  }
  return null;
}

function planLegacyDoc(doc, provider, entry) {
  const catalog = findProviderCatalog(doc, provider);
  if (!catalog) return { doc, changed: false };
  const ids = catalog.models
    .filter((item) => item && typeof item === "object")
    .map((item) => item.id)
    .filter((id) => typeof id === "string" && id !== "");
  const pinsOutside = ids.some((id) => id !== entry.id);
  if (!pinsOutside) return { doc, changed: false };
  const next = structuredClone(doc);
  findProviderCatalog(next, provider).models = [entry];
  return { doc: next, changed: true };
}

async function collectLegacyFiles(home) {
  const agentsDir = path.join(home, "agents");
  let entries;
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const files = [];
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const filePath = path.join(agentsDir, dirent.name, "agent", "models.json");
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) files.push(filePath);
    } catch {
      // No legacy catalog for this agent.
    }
  }
  files.sort();
  return files;
}

async function buildPlan({ home, provider, model }) {
  const entry = buildModelEntry(model);
  const configPath = path.join(home, "openclaw.json");
  const config = await readJsonFile(configPath);
  const nextConfig = planOpenclawDoc(config.doc, provider, entry);
  const items = [
    {
      kind: "openclaw",
      path: configPath,
      existed: config.exists,
      raw: config.raw,
      doc: nextConfig,
      changed: !deepEqual(nextConfig, config.doc),
    },
  ];

  for (const legacyPath of await collectLegacyFiles(home)) {
    const legacy = await readJsonFile(legacyPath);
    const result = planLegacyDoc(legacy.doc, provider, entry);
    items.push({
      kind: "legacy",
      path: legacyPath,
      existed: legacy.exists,
      raw: legacy.raw,
      doc: result.doc,
      changed: result.changed,
    });
  }

  return { entry, items, changed: items.some((item) => item.changed) };
}

function restartGateway() {
  const env = { ...process.env, XDG_RUNTIME_DIR: GATEWAY_XDG_RUNTIME_DIR };
  const probe = spawnSync("systemctl", ["--user", "cat", GATEWAY_UNIT], { env, encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    return { status: "skipped", reason: "unit-absent" };
  }
  const result = spawnSync("systemctl", ["--user", "restart", GATEWAY_UNIT], {
    env,
    encoding: "utf8",
  });
  if (result.error) return { status: "skipped", reason: "restart-failed" };
  if (result.status !== 0) return { status: "skipped", reason: `restart-failed (exit ${result.status})` };
  return { status: "restarted" };
}

function printPlanHuman(plan, meta) {
  const lines = [
    `provider: ${meta.provider}`,
    `baseUrl: ${meta.baseUrl}`,
    `source: ${meta.source}${meta.revision === undefined ? "" : ` (revision ${meta.revision})`}`,
    `model: ${plan.entry.id}`,
  ];
  for (const item of plan.items) {
    const state = item.changed ? (meta.write ? "change" : "would change") : "unchanged";
    lines.push(`${item.path}: ${state}`);
  }
  lines.push(`changed: ${plan.changed}`);
  for (const line of lines) console.log(`${now()} ${line}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (isFlag(args.help)) {
    console.log(USAGE);
    return 0;
  }

  const json = isFlag(args.json);
  const dryRun = isFlag(args["dry-run"]);
  const check = isFlag(args.check);
  const restart = isFlag(args.restart);
  const provider = typeof args.provider === "string" && args.provider !== "" ? args.provider : DEFAULT_PROVIDER;

  let timeoutMs = Number.parseInt(args["timeout-ms"] ?? "", 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;

  let secret = "";
  try {
    const home = path.resolve(expandHome(args.home || process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw")));
    const configPath = path.join(home, "openclaw.json");
    const config = await readJsonFile(configPath);
    const providerConfig = ensureObject(ensureObject(ensureObject(config.doc.models).providers)[provider]);

    const baseUrlRaw = args["base-url"] || providerConfig.baseUrl;
    if (typeof baseUrlRaw !== "string" || baseUrlRaw.trim() === "") {
      throw new Error(
        `no base URL: pass --base-url or set models.providers.${provider}.baseUrl in ${configPath}`,
      );
    }
    const baseUrl = baseUrlRaw.replace(/\/+$/, "");

    const keyEnv =
      typeof args["key-env"] === "string" && args["key-env"] !== ""
        ? args["key-env"]
        : typeof providerConfig.apiKey?.id === "string" && providerConfig.apiKey.id !== ""
          ? providerConfig.apiKey.id
          : DEFAULT_KEY_ENV;
    const key = process.env[keyEnv] || "";
    secret = key;
    if (key === "") {
      throw new Error(`missing API key: environment variable ${keyEnv} is not set`);
    }

    const discovered = await discoverModel({ baseUrl, key, timeoutMs });
    const plan = await buildPlan({ home, provider, model: discovered.model });

    const meta = {
      provider,
      baseUrl,
      source: discovered.source,
      revision: discovered.revision,
      write: !dryRun && !check,
    };

    const files = plan.items.map((item) => ({
      path: item.path,
      changed: item.changed,
      written: false,
      backup: null,
    }));

    if (!json) printPlanHuman(plan, meta);

    if (check) {
      const summary = {
        ok: true,
        mode: "check",
        provider,
        baseUrl,
        source: discovered.source,
        model: plan.entry.id,
        check: plan.changed ? "mismatch" : "match",
        changed: plan.changed,
        files,
      };
      if (json) printJson(summary);
      else console.log(`${now()} check: ${summary.check}`);
      return plan.changed ? 0 : 1;
    }

    if (!plan.changed) {
      const summary = {
        ok: true,
        provider,
        baseUrl,
        source: discovered.source,
        model: plan.entry.id,
        changed: false,
        files,
        dryRun,
      };
      if (json) printJson(summary);
      else console.log(`${now()} nothing to change`);
      return 0;
    }

    if (dryRun) {
      const summary = {
        ok: true,
        provider,
        baseUrl,
        source: discovered.source,
        model: plan.entry.id,
        changed: true,
        dryRun: true,
        files,
      };
      if (json) printJson(summary);
      else console.log(`${now()} dry-run: no files written`);
      return 0;
    }

    const stamp = backupStamp();
    for (let index = 0; index < plan.items.length; index += 1) {
      const item = plan.items[index];
      if (!item.changed) continue;
      const mode = secureMode(await fileMode(item.path));
      if (item.existed) {
        files[index].backup = await backupFile(item.path, stamp);
      }
      await writeAtomic(item.path, serializeDoc(item.doc, item.raw), mode);
      files[index].written = true;
    }

    let restartResult;
    if (restart) {
      restartResult = restartGateway();
    }

    const summary = {
      ok: true,
      provider,
      baseUrl,
      source: discovered.source,
      model: plan.entry.id,
      changed: true,
      files,
    };
    if (restartResult) summary.restart = restartResult;
    if (json) printJson(summary);
    else {
      for (const file of files) {
        if (!file.written) continue;
        console.log(`${now()} wrote ${file.path}${file.backup ? ` (backup ${file.backup})` : ""}`);
      }
      if (restartResult) console.log(`${now()} restart: ${restartResult.status}${restartResult.reason ? ` (${restartResult.reason})` : ""}`);
      console.log(`${now()} changed: true`);
    }
    return 0;
  } catch (err) {
    const rawMessage = err?.message || String(err);
    const message = secret ? rawMessage.split(secret).join("***") : rawMessage;
    if (json) printJson({ ok: false, error: message });
    else console.error(`${now()} ERROR ${message}`);
    return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`${now()} ERROR ${err?.stack || err}`);
    process.exitCode = 2;
  });
