#!/usr/bin/env node
'use strict';

// Replay the installed QQ plugin's real delivery closure and forward builder.
// Only network transport and unrelated media/context services are mocked.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');

const repo = path.resolve(process.argv[2] || '.');
const profilePath = process.argv[3];
const source = fs.readFileSync(path.join(repo, 'src/channel.ts'), 'utf8');
const profile = profilePath ? JSON.parse(fs.readFileSync(profilePath, 'utf8')) : {};
const qq = profile.channels?.qq || {};
const threshold = Number(qq.forwardLongReplyThreshold ?? 30);
assert.equal(threshold, 30, 'The installed QQ profile must use threshold 30');

function sourceFunction(name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = pattern.exec(source);
  assert.ok(match, `Actual source function ${name} is missing`);
  // A multiline parameter type can also start a line with `}`; only a full
  // top-level closing line terminates the actual function body.
  const closing = /^}[\t ]*;?[\t ]*$/gm;
  closing.lastIndex = match.index;
  const end = closing.exec(source);
  assert.ok(end && end.index > match.index, `Cannot find the end of ${name}`);
  return source.slice(match.index, end.index + end[0].length);
}

const helperNames = [
  'normalizeAssistantTextPhase', 'resolveReplyPayloadPhase',
  'isInternalNoticeLine', 'stripInternalNoticeText', 'escapeRegExpText',
  'shortenVisibleModelRefs', 'normalizeQQVisibleText',
  'sendLongTextAsForwardMessage',
];
const start = source.indexOf('let deliveredAnything = false;');
const end = source.indexOf('let replyToBody = "";', start);
assert.ok(start >= 0 && end > start, 'Actual QQ delivery closure was not found');
const code = `(() => {
  ${helperNames.map(sourceFunction).join('\n')}
  ${source.slice(start, end)}
  return {
    deliver,
    flush: async () => {
      await flushBufferedFinalTexts();
      await flushBufferedUnknownTexts('verification');
    },
    flags: () => ({ deliveredAnything, sawReplyContent }),
  };
})()`;
const executable = new vm.Script(stripTypeScriptTypes(code, {
  mode: 'transform', sourceUrl: 'installed-qq-delivery-replay.ts',
}));

function fixture(group, rejectForward = false) {
  const records = [];
  const config = {
    forwardLongReplyThreshold: threshold,
    forwardNodeCharLimit: Number(qq.forwardNodeCharLimit ?? 1800),
    forwardNodeName: qq.forwardNodeName || 'OpenClaw',
    showReplySessionSource: false,
    formatMarkdown: false, antiRiskMode: false, enableTTS: false,
    rateLimitMs: 0, maxMessageLength: 4000,
  };
  const client = {
    getSelfId: () => 10000,
    sendWithResponse: async (action, params) => {
      records.push({ kind: 'forward', action, params, rejected: rejectForward });
      if (rejectForward) throw new Error('Simulated unavailable forward API');
      return { message_id: 1 };
    },
  };
  const globals = {
    config, client,
    isGroup: group, isGuild: false, groupId: group ? 20000 : undefined,
    guildId: undefined, channelId: undefined,
    userId: 30000, deliveryTo: group ? 'group:20000' : 'user:30000',
    activeTempSlot: null, pendingAutoReact: null,
    account: { accountId: 'verification' }, event: { time: 1 },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date,
    buildReplySessionSourcePrefix: () => '',
    compactQQContextText: (s) => s,
    rememberQQConversationMessage() {},
    extractOutboundMessageId: () => 1,
    splitMessage: (s, n) => {
      const chunks = [];
      for (let i = 0; i < s.length; i += n) chunks.push(s.slice(i, i + n));
      return chunks;
    },
    stripMarkdown: (s) => s,
    processAntiRisk: (s) => s,
    resolveInlineCqRecord: async (s) => s,
    collectOutboundMediaItemsFromPayload: (p) => p.fixtureMedia || [],
    sendQQMediaMessage: async (p) => {
      records.push({ kind: 'media', url: p.mediaUrl });
      return { message_id: 2 };
    },
    sleep: async () => {},
    sendOneBotMessageWithAck: async (_client, to, text) => {
      records.push({ kind: 'plain', to, text });
      return { ok: true, data: { message_id: 1 } };
    },
  };
  return { ...executable.runInNewContext(globals), records };
}

const notice = 'Thinking level clamped to xhigh for sub2api/deepseek-v4.1-flash (requested max; preference retained)';
const results = [];
async function verify(group, label, payloads, expected, options = {}) {
  const f = fixture(group, options.rejectForward);
  for (const [payload, info] of payloads) await f.deliver(payload, info);
  await f.flush();
  const forwarded = f.records.filter((r) => r.kind === 'forward' && !r.rejected);
  const plain = f.records.filter((r) => r.kind === 'plain');
  if (expected === 'forward') {
    assert.equal(forwarded.length, 1, label);
    assert.equal(plain.length, 0, label);
    assert.equal(forwarded[0].action, group ? 'send_group_forward_msg' : 'send_private_forward_msg');
    const nodes = forwarded[0].params.messages;
    assert.ok(nodes.length > 0 && nodes.every((node) => node.type === 'node'));
    assert.equal(nodes.map((node) => node.data.content).join('').length, options.length);
  } else if (expected === 'plain') {
    assert.ok(plain.length > 0, label);
    assert.equal(forwarded.length, 0, label);
    assert.equal(plain.map((r) => r.text).join('').length, options.length);
  } else {
    assert.equal(forwarded.length, 0, label);
    assert.equal(plain.length, 0, label);
  }
  if (options.media) assert.equal(f.records.filter((r) => r.kind === 'media').length, 1, label);
  results.push({ mode: group ? 'group' : 'private', case: label, pass: true,
    delivery: expected, actions: f.records.map((r) => r.action || r.kind) });
}

(async () => {
  for (const group of [false, true]) {
    for (const phase of ['final_answer', 'commentary']) {
      for (const n of [29, 30, 31]) {
        await verify(group, `${phase}-${n}`, [[{ text: '字'.repeat(n), phase }]],
          n > 30 ? 'forward' : 'plain', { length: n });
      }
    }
    for (const n of [30, 31]) {
      await verify(group, `unknown-block-${n}`, [[{ text: '字'.repeat(n) }, { kind: 'block' }]],
        n > 30 ? 'forward' : 'plain', { length: n });
      await verify(group, `diagnostic-plus-${n}`, [[{ text: `${notice}\n${'字'.repeat(n)}`, phase: 'final_answer' }]],
        n > 30 ? 'forward' : 'plain', { length: n });
    }
    await verify(group, 'two-blocks-total-30', [
      [{ text: '字'.repeat(15), phase: 'final_answer' }],
      [{ text: '字'.repeat(15), phase: 'final_answer' }],
    ], 'plain', { length: 30 });
    await verify(group, 'two-blocks-total-31', [
      [{ text: '字'.repeat(15), phase: 'final_answer' }],
      [{ text: '字'.repeat(16), phase: 'final_answer' }],
    ], 'forward', { length: 31 });
    await verify(group, 'diagnostic-only', [[{ text: notice, phase: 'final_answer' }]], 'none');
    await verify(group, 'diagnostic-and-media', [[{ text: notice, phase: 'final_answer',
      fixtureMedia: [{ url: 'fixture://image', kind: 'image', name: 'test' }] }]], 'none', { media: true });
    await verify(group, 'forward-unavailable-fallback', [[{ text: '字'.repeat(31), phase: 'final_answer' }]],
      'plain', { rejectForward: true, length: 31 });
  }
  process.stdout.write(`${JSON.stringify({ threshold, source: path.join(repo, 'src/channel.ts'),
    tests: results.length, passed: results.length, results }, null, 2)}\n`);
})().catch((err) => {
  console.error(err.stack || String(err));
  process.exitCode = 1;
});
