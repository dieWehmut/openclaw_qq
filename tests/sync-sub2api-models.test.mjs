import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "../scripts/sync-sub2api-models.mjs");
const SECRET = "sk-test-secret-never-logged-7f3a";
const KEY_ENV = "TEST_SUB2API_KEY";

const BASE_CONFIG = {
  gateway: { port: 18789 },
  models: {
    providers: {
      sub2api: {
        baseUrl: "http://127.0.0.1:9",
        apiKey: { id: KEY_ENV },
        api: "openai-completions",
        models: [{ id: "stale-model", name: "stale-model" }],
      },
      other: { baseUrl: "http://example.invalid", models: [{ id: "keep-me" }] },
    },
  },
  agents: {
    defaults: {
      model: { primary: "sub2api/stale-model", fallbacks: ["other/keep-me"] },
      models: {
        "sub2api/stale-model": { alias: "stale-model" },
        "other/keep-me": { alias: "keep-me" },
      },
      workspace: "/home/dev/.openclaw/workspace",
    },
  },
  channels: { qq: { wsUrl: "ws://127.0.0.1:3001" } },
};

function keyGroupBody(overrides = {}) {
  return {
    schema_version: 1,
    object: "sub2api.key_group",
    key: { id: "key_123", group_id: "grp_1" },
    group: { id: "grp_1", name: "default", platform: "openai", status: "active" },
    models: [{ id: "gpt-4o-mini", upstream_model: "gpt-4o-mini", aliases: [] }],
    revision: 7,
    ...overrides,
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function startServer(routes) {
  const state = { hits: [], auth: [] };
  const server = http.createServer((req, res) => {
    state.hits.push(req.url);
    state.auth.push(req.headers.authorization);
    const route = routes[req.url];
    if (!route) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    route(req, res, state);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function makeHome(config) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sync-sub2api-"));
  if (config !== undefined) {
    await fs.writeFile(
      path.join(home, "openclaw.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
  }
  return home;
}

function runScript(args, { home, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: {
        ...process.env,
        OPENCLAW_HOME: home,
        [KEY_ENV]: SECRET,
        SUB2API_API_KEY: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function readConfig(home) {
  return JSON.parse(await fs.readFile(path.join(home, "openclaw.json"), "utf8"));
}

async function listBackups(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const entries = await fs.readdir(dir);
  return entries.filter((name) => name.startsWith(`${base}.bak-`));
}

function assertNoSecret(out) {
  assert.equal(out.stdout.includes(SECRET), false, "stdout leaked the API key");
  assert.equal(out.stderr.includes(SECRET), false, "stderr leaked the API key");
}

test("tier 1 key-group success writes the discovered model", async (t) => {
  const home = await makeHome(BASE_CONFIG);
  const server = await startServer({
    "/sub2api/key-group": (_req, res) =>
      sendJson(
        res,
        200,
        keyGroupBody({
          models: [
            {
              id: "gpt-4o-mini",
              context_window: 200000,
              max_tokens: 8192,
              reasoning: true,
              input: ["text"],
            },
          ],
        }),
      ),
    "/models": (_req, res) => sendJson(res, 500, { object: "list", data: [] }),
  });
  t.after(async () => {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  const out = await runScript(["--base-url", server.baseUrl], { home });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(server.state.hits.includes("/models"), false, "tier 2 must not run");
  assert.deepEqual(server.state.auth[0], `Bearer ${SECRET}`);
  assertNoSecret(out);

  const config = await readConfig(home);
  assert.deepEqual(config.models.providers.sub2api.models, [
    {
      id: "gpt-4o-mini",
      name: "gpt-4o-mini",
      input: ["text"],
      contextWindow: 200000,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      api: "openai-completions",
      reasoning: true,
    },
  ]);
  assert.deepEqual(config.agents.defaults.models, {
    "sub2api/gpt-4o-mini": { alias: "gpt-4o-mini" },
  });
  assert.deepEqual(config.agents.defaults.model, {
    primary: "sub2api/gpt-4o-mini",
    fallbacks: [],
  });

  // unrelated keys are merged, never replaced
  assert.equal(config.gateway.port, 18789);
  assert.equal(config.channels.qq.wsUrl, "ws://127.0.0.1:3001");
  assert.deepEqual(config.models.providers.other.models, [{ id: "keep-me" }]);
  assert.equal(config.agents.defaults.workspace, "/home/dev/.openclaw/workspace");
  assert.equal(config.models.providers.sub2api.apiKey.id, KEY_ENV);

  const mode = (await fs.stat(path.join(home, "openclaw.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("tier 1 404 falls back to tier 2 /models", async (t) => {
  const home = await makeHome(BASE_CONFIG);
  const server = await startServer({
    "/sub2api/key-group": (_req, res) => sendJson(res, 404, { error: "not found" }),
    "/models": (_req, res) => sendJson(res, 200, { object: "list", data: [{ id: "gpt-4.1-mini" }] }),
  });
  t.after(async () => {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  const out = await runScript(["--base-url", server.baseUrl, "--json"], { home });
  assert.equal(out.code, 0, out.stderr);
  assertNoSecret(out);
  const summary = JSON.parse(out.stdout);
  assert.equal(summary.source, "models");
  assert.equal(summary.model, "gpt-4.1-mini");

  const config = await readConfig(home);
  assert.equal(config.models.providers.sub2api.models[0].id, "gpt-4.1-mini");
  assert.equal(config.models.providers.sub2api.models[0].contextWindow, 1000000);
  assert.deepEqual(config.agents.defaults.model, {
    primary: "sub2api/gpt-4.1-mini",
    fallbacks: [],
  });
});

test("unusable tier 1 body also falls back to tier 2", async (t) => {
  const home = await makeHome(BASE_CONFIG);
  const server = await startServer({
    "/sub2api/key-group": (_req, res) =>
      sendJson(
        res,
        200,
        keyGroupBody({
          group: { id: "grp_1", name: "default", platform: "openai", status: "disabled" },
        }),
      ),
    "/models": (_req, res) => sendJson(res, 200, { object: "list", data: [{ id: "gpt-4o-mini" }] }),
  });
  t.after(async () => {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  const out = await runScript(["--base-url", server.baseUrl], { home });
  assert.equal(out.code, 0, out.stderr);
  const config = await readConfig(home);
  assert.equal(config.models.providers.sub2api.models[0].id, "gpt-4o-mini");
});

test("ambiguous tier 2 model list exits 2 and writes nothing", async (t) => {
  const home = await makeHome(BASE_CONFIG);
  const configPath = path.join(home, "openclaw.json");
  const before = await fs.readFile(configPath, "utf8");
  const server = await startServer({
    "/sub2api/key-group": (_req, res) => sendJson(res, 404, { error: "not found" }),
    "/models": (_req, res) =>
      sendJson(res, 200, {
        object: "list",
        data: [{ id: "gpt-4o-mini" }, { id: "gpt-4.1-mini" }],
      }),
  });
  t.after(async () => {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  const out = await runScript(["--base-url", server.baseUrl], { home });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /ambiguous model list/);
  assertNoSecret(out);
  assert.equal(await fs.readFile(configPath, "utf8"), before);
  assert.deepEqual(await listBackups(configPath), []);
});

test("--check reports mismatch (0) then match (1) without writing", async (t) => {
  const home = await makeHome(BASE_CONFIG);
  const configPath = path.join(home, "openclaw.json");
  const server = await startServer({
    "/sub2api/key-group": (_req, res) => sendJson(res, 200, keyGroupBody()),
  });
  t.after(async () => {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  const before = await fs.readFile(configPath, "utf8");

  const mismatch = await runScript(["--base-url", server.baseUrl, "--check"], { home });
  assert.equal(mismatch.code, 0, mismatch.stderr);
  assert.equal(await fs.readFile(configPath, "utf8"), before);
  assert.deepEqual(await listBackups(configPath), []);

  const sync = await runScript(["--base-url", server.baseUrl], { home });
  assert.equal(sync.code, 0, sync.stderr);

  const match = await runScript(["--base-url", server.baseUrl, "--check", "--json"], { home });
  assert.equal(match.code, 1, match.stderr);
  assert.equal(JSON.parse(match.stdout).check, "match");
  assert.equal(await fs.readFile(configPath, "utf8").then(() => true), true);
});

test("--dry-run prints the plan and writes nothing", async (t) => {
  const home = await makeHome(BASE_CONFIG);
  const configPath = path.join(home, "openclaw.json");
  const server = await startServer({
    "/sub2api/key-group": (_req, res) => sendJson(res, 200, keyGroupBody()),
  });
  t.after(async () => {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  const before = await fs.readFile(configPath, "utf8");
  const out = await runScript(["--base-url", server.baseUrl, "--dry-run", "--json"], { home });
  assert.equal(out.code, 0, out.stderr);
  const summary = JSON.parse(out.stdout);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.changed, true);
  assert.equal(summary.files[0].written, false);
  assert.equal(await fs.readFile(configPath, "utf8"), before);
  assert.deepEqual(await listBackups(configPath), []);
});

test("backs up the original config before the first write", async (t) => {
  const home = await makeHome(BASE_CONFIG);
  const configPath = path.join(home, "openclaw.json");
  const server = await startServer({
    "/sub2api/key-group": (_req, res) => sendJson(res, 200, keyGroupBody()),
  });
  t.after(async () => {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  const original = await fs.readFile(configPath, "utf8");
  const out = await runScript(["--base-url", server.baseUrl], { home });
  assert.equal(out.code, 0, out.stderr);

  const backups = await listBackups(configPath);
  assert.equal(backups.length, 1);
  const backupPath = path.join(home, backups[0]);
  assert.match(backups[0], /^openclaw\.json\.bak-\d{8}T\d{6}Z$/);
  assert.equal(await fs.readFile(backupPath, "utf8"), original);
  assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);

  // second run is a no-op: no new backup, changed false
  const again = await runScript(["--base-url", server.baseUrl, "--json"], { home });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).changed, false);
  assert.equal((await listBackups(configPath)).length, 1);
});

test("legacy per-agent models.json is rewritten in place", async (t) => {
  const home = await makeHome(BASE_CONFIG);
  const legacyDir = path.join(home, "agents", "main", "agent");
  await fs.mkdir(legacyDir, { recursive: true });
  const legacyPath = path.join(legacyDir, "models.json");
  await fs.writeFile(
    legacyPath,
    `${JSON.stringify(
      {
        note: "keep me",
        providers: {
          sub2api: { models: [{ id: "old-model" }, { id: "another-old" }] },
          other: { models: [{ id: "untouched" }] },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const server = await startServer({
    "/sub2api/key-group": (_req, res) => sendJson(res, 200, keyGroupBody()),
  });
  t.after(async () => {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  const out = await runScript(["--base-url", server.baseUrl, "--json"], { home });
  assert.equal(out.code, 0, out.stderr);
  const summary = JSON.parse(out.stdout);
  assert.equal(summary.files.length, 2);
  assert.equal(summary.files[1].path, legacyPath);
  assert.equal(summary.files[1].changed, true);
  assert.ok(summary.files[1].backup);

  const legacy = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  assert.equal(legacy.note, "keep me");
  assert.deepEqual(legacy.providers.sub2api.models.map((model) => model.id), ["gpt-4o-mini"]);
  assert.deepEqual(legacy.providers.other.models, [{ id: "untouched" }]);
  assert.equal((await listBackups(legacyPath)).length, 1);
});

test("legacy catalog that already matches is left untouched", async (t) => {
  const home = await makeHome(BASE_CONFIG);
  const legacyDir = path.join(home, "agents", "main", "agent");
  await fs.mkdir(legacyDir, { recursive: true });
  const legacyPath = path.join(legacyDir, "models.json");
  const legacyRaw = `${JSON.stringify(
    { providers: { sub2api: { models: [{ id: "gpt-4o-mini" }] } } },
    null,
    2,
  )}\n`;
  await fs.writeFile(legacyPath, legacyRaw, "utf8");

  const server = await startServer({
    "/sub2api/key-group": (_req, res) => sendJson(res, 200, keyGroupBody()),
  });
  t.after(async () => {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  const out = await runScript(["--base-url", server.baseUrl], { home });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(await fs.readFile(legacyPath, "utf8"), legacyRaw);
  assert.deepEqual(await listBackups(legacyPath), []);
});

test("the API key never reaches stdout or stderr, even on failure", async (t) => {
  const home = await makeHome(BASE_CONFIG);
  const server = await startServer({
    "/sub2api/key-group": (_req, res) => sendJson(res, 401, { error: `invalid key ${SECRET}` }),
    "/models": (_req, res) => sendJson(res, 401, { error: `invalid key ${SECRET}` }),
  });
  t.after(async () => {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  for (const extra of [[], ["--json"], ["--check"], ["--dry-run"]]) {
    const out = await runScript(["--base-url", server.baseUrl, ...extra], { home });
    assert.equal(out.code, 2, `expected exit 2 for ${extra.join(" ") || "default"}`);
    assertNoSecret(out);
  }
});

test("--help exits 0 and prints usage", async () => {
  const out = await runScript(["--help"], { home: os.tmpdir() });
  assert.equal(out.code, 0);
  assert.match(out.stdout, /Usage: node scripts\/sync-sub2api-models\.mjs/);
});
