import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- constants

const SLACK_API = 'https://slack.com/api/';

const STATUS_APPROVED = 'approved';
const STATUS_CHANGES_REQUESTED = 'changes-requested';
const STATUS_MERGED = 'merged';
const STATUS_CLOSED = 'closed';

const FLIP_OPPOSITE = {
  [STATUS_APPROVED]: STATUS_CHANGES_REQUESTED,
  [STATUS_CHANGES_REQUESTED]: STATUS_APPROVED,
};

const TOLERATED_REACTION_ERRORS = new Set([
  'already_reacted', 'no_reaction',
  'not_in_channel', 'channel_not_found', 'message_not_found',
]);
const STALE_MATCH_ERRORS = new Set([
  'not_in_channel', 'channel_not_found', 'message_not_found',
]);
const AUTH_ERRORS = new Set([
  'invalid_auth', 'token_revoked', 'account_inactive', 'not_authed',
]);

const CHANNEL_LIST_TTL_S = 24 * 3600;
const PR_STALE_TTL_S = 90 * 24 * 3600;
const MAX_PR_ENTRIES = 10000;
const MAX_CHANNELS_PER_RUN = 100;
const HISTORY_PAGES_PER_CHANNEL = 3;
const HISTORY_LOOKBACK_S = 30 * 24 * 3600;
const REACTIONS_PER_RUN_CAP = 50;
const SLACK_PACE_MS = 1200;
const RETRY_AFTER_CAP_S = 60;
const MAX_RETRIES = 3;
const CACHE_KEY_PREFIX = 'slack-emoji-reactions-state-';
const CACHE_VERSION = 'slack-emoji-reactions-v1';

// ---------------------------------------------------------------- helpers

const log  = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err  = (...a) => console.error(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

function input(name) {
  // GHA preserves hyphens in INPUT_* env vars (only spaces become underscores).
  return process.env[`INPUT_${name.toUpperCase()}`] || '';
}

function maskSecret(s) {
  if (s) console.log(`::add-mask::${s}`);
}

class AuthError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// ---------------------------------------------------------------- slack client

let lastSlackCallAt = 0;
// Test hooks: override the fetch impl and self-pacing during unit tests.
let _fetch = null;
let _paceMs = null;

async function slackCall(method, params, token) {
  const url = SLACK_API + method;
  const paceMs = _paceMs ?? SLACK_PACE_MS;
  const fetchImpl = _fetch ?? globalThis.fetch;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const wait = paceMs - (Date.now() - lastSlackCallAt);
    if (wait > 0) await sleep(wait);
    lastSlackCallAt = Date.now();

    let res, body;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(params || {}),
      });
      body = await res.json();
    } catch (e) {
      warn(`slack ${method} network error: ${e.message} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
      if (attempt >= MAX_RETRIES) return { ok: false, error: 'network_error' };
      await sleep(1000);
      continue;
    }

    const isRateLimited = res.status === 429 || (body && body.ok === false && body.error === 'ratelimited');
    if (isRateLimited) {
      const retry = Math.min(parseInt(res.headers.get('retry-after') || '1', 10) || 1, RETRY_AFTER_CAP_S);
      log(`slack ${method} ratelimited; retry-after ${retry}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
      if (attempt >= MAX_RETRIES) return body || { ok: false, error: 'ratelimited' };
      await sleep(retry * 1000);
      continue;
    }

    return body;
  }
  return { ok: false, error: 'retries_exhausted' };
}

function checkAuth(res, method) {
  if (res && res.ok === false && AUTH_ERRORS.has(res.error)) {
    throw new AuthError(res.error);
  }
}

// ---------------------------------------------------------------- url match

function tokenizeAngles(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    const gt = text.indexOf('>', lt + 1);
    if (gt < 0) break;
    let cand = text.slice(lt + 1, gt);
    const pipe = cand.indexOf('|');
    if (pipe >= 0) cand = cand.slice(0, pipe);
    out.push(cand);
    i = gt + 1;
  }
  return out;
}

function walkForUrls(node, out) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.url === 'string') out.push(node.url);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) for (const item of v) walkForUrls(item, out);
    else if (v && typeof v === 'object') walkForUrls(v, out);
  }
}

function urlsFromMessage(message) {
  const out = [];
  if (typeof message.text === 'string') {
    for (const cand of tokenizeAngles(message.text)) out.push(cand);
  }
  for (const att of message.attachments || []) {
    if (typeof att.title_link === 'string') out.push(att.title_link);
    if (typeof att.from_url === 'string') out.push(att.from_url);
  }
  for (const block of message.blocks || []) walkForUrls(block, out);
  return out;
}

function matchesPullUrl(candidate, owner, repo, num) {
  let u;
  try { u = new URL(candidate); } catch { return false; }
  if (u.host !== 'github.com') return false;
  const parts = u.pathname.split('/');
  return parts.length === 5
    && parts[0] === ''
    && parts[1] === owner
    && parts[2] === repo
    && parts[3] === 'pull'
    && parts[4] === String(num);
}

// ---------------------------------------------------------------- event → status

function deriveStatus(eventName, payload) {
  if (eventName === 'pull_request_review') {
    if (payload.action !== 'submitted') return null;
    const state = payload.review && payload.review.state;
    if (state === 'approved') return STATUS_APPROVED;
    if (state === 'changes_requested') return STATUS_CHANGES_REQUESTED;
    return null;
  }
  if (eventName === 'pull_request') {
    if (payload.action !== 'closed') return null;
    return payload.pull_request && payload.pull_request.merged ? STATUS_MERGED : STATUS_CLOSED;
  }
  return null;
}

function prContext(payload) {
  const pr = payload.pull_request;
  if (!pr || typeof pr.html_url !== 'string') return null;
  const u = new URL(pr.html_url);
  const parts = u.pathname.split('/');
  const num = parseInt(parts[4], 10);
  if (parts.length !== 5 || parts[3] !== 'pull' || !Number.isFinite(num)) return null;
  return { owner: parts[1], repo: parts[2], num, prUrl: pr.html_url };
}

// ---------------------------------------------------------------- discovery

async function ensureBotUserId(state, token) {
  if (state.botUserId) return state.botUserId;
  const res = await slackCall('auth.test', {}, token);
  checkAuth(res);
  if (!res.ok) throw new Error(`auth.test failed: ${res.error}`);
  state.botUserId = res.user_id;
  log(`auth.test → bot user ${state.botUserId}`);
  return state.botUserId;
}

async function ensureChannels(state, token) {
  const fresh = state.channels && state.channelsRefreshedAt
    && (nowS() - state.channelsRefreshedAt) < CHANNEL_LIST_TTL_S;
  if (fresh) return state.channels;

  const channels = [];
  let cursor = '';
  while (true) {
    const params = {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
    };
    if (cursor) params.cursor = cursor;
    const res = await slackCall('conversations.list', params, token);
    checkAuth(res);
    if (!res.ok) throw new Error(`conversations.list failed: ${res.error}`);
    for (const c of res.channels || []) {
      if (c.is_member) channels.push({ id: c.id, name: c.name });
    }
    cursor = (res.response_metadata && res.response_metadata.next_cursor) || '';
    if (!cursor) break;
  }
  state.channels = channels;
  state.channelsRefreshedAt = nowS();
  log(`channels refreshed: ${channels.length} bot-member channel(s)`);
  return channels;
}

async function discoverMatches(channels, owner, repo, num, token) {
  const matches = [];
  const oldest = String(nowS() - HISTORY_LOOKBACK_S);
  let scanned = 0;
  for (const ch of channels) {
    if (scanned >= MAX_CHANNELS_PER_RUN) {
      warn(`channels-per-run cap (${MAX_CHANNELS_PER_RUN}) reached; skipped ${channels.length - scanned} remaining`);
      break;
    }
    scanned++;
    let cursor = '';
    let foundInChannel = false;
    for (let page = 0; page < HISTORY_PAGES_PER_CHANNEL; page++) {
      const params = { channel: ch.id, oldest, limit: 200 };
      if (cursor) params.cursor = cursor;
      const res = await slackCall('conversations.history', params, token);
      checkAuth(res);
      if (!res.ok) {
        warn(`conversations.history ${ch.id}(${ch.name}): ${res.error}`);
        break;
      }
      for (const msg of res.messages || []) {
        for (const cand of urlsFromMessage(msg)) {
          if (matchesPullUrl(cand, owner, repo, num)) {
            matches.push({ channel: ch.id, ts: msg.ts });
            foundInChannel = true;
            break;
          }
        }
      }
      cursor = (res.response_metadata && res.response_metadata.next_cursor) || '';
      if (!cursor || !res.has_more) break;
    }
    if (foundInChannel) log(`match in #${ch.name} (${ch.id})`);
  }
  return matches;
}

// ---------------------------------------------------------------- reactions

async function reactToMatch(match, status, emoji, oppositeEmoji, botUserId, isRerun, token) {
  if (!isRerun && oppositeEmoji) {
    const got = await slackCall('reactions.get', {
      channel: match.channel,
      timestamp: match.ts,
      full: true,
    }, token);
    checkAuth(got);
    if (got.ok) {
      const reactions = (got.message && got.message.reactions) || [];
      const opp = reactions.find(r => r.name === oppositeEmoji);
      if (opp && (opp.users || []).includes(botUserId)) {
        const rm = await slackCall('reactions.remove', {
          channel: match.channel, timestamp: match.ts, name: oppositeEmoji,
        }, token);
        checkAuth(rm);
        log(JSON.stringify({
          match: `${match.channel}/${match.ts}`, status, action: 'remove',
          name: oppositeEmoji, ok: !!rm.ok, error: rm.error || null,
        }));
      }
    } else if (!TOLERATED_REACTION_ERRORS.has(got.error)) {
      warn(`reactions.get ${match.channel}/${match.ts}: ${got.error}`);
    }
  }

  const add = await slackCall('reactions.add', {
    channel: match.channel, timestamp: match.ts, name: emoji,
  }, token);
  checkAuth(add);
  log(JSON.stringify({
    match: `${match.channel}/${match.ts}`, status, action: 'add',
    name: emoji, ok: !!add.ok, error: add.error || null,
  }));
  return { ok: !!add.ok, error: add.error };
}

// ---------------------------------------------------------------- cache (GHA v1 API)

const CACHE_BASE = (() => {
  const url = process.env.ACTIONS_CACHE_URL || '';
  if (!url) return '';
  return url.endsWith('/') ? url : url + '/';
})();
const CACHE_TOKEN = process.env.ACTIONS_RUNTIME_TOKEN || '';
const CACHE_HEADERS = () => ({
  'Authorization': `Bearer ${CACHE_TOKEN}`,
  'Accept': 'application/json;api-version=6.0-preview.1',
});

async function cacheRestore() {
  if (!CACHE_BASE || !CACHE_TOKEN) return null;
  try {
    const u = new URL('_apis/artifactcache/cache', CACHE_BASE);
    // Primary key won't match anything we ever save; second is the prefix.
    u.searchParams.set('keys', `${CACHE_KEY_PREFIX}__sentinel__,${CACHE_KEY_PREFIX}`);
    u.searchParams.set('version', CACHE_VERSION);
    const res = await fetch(u, { headers: CACHE_HEADERS() });
    if (res.status === 204) { log('cache: cold (no prior entry)'); return null; }
    if (!res.ok) { warn(`cache restore lookup status ${res.status}`); return null; }
    const meta = await res.json();
    if (!meta || !meta.archiveLocation) return null;
    const blob = await fetch(meta.archiveLocation);
    if (!blob.ok) { warn(`cache blob fetch status ${blob.status}`); return null; }
    const text = await blob.text();
    const state = JSON.parse(text);
    log(`cache: restored ${meta.cacheKey}`);
    return state;
  } catch (e) {
    warn(`cache restore failed: ${e.message}`);
    return null;
  }
}

async function cacheSave(state, key) {
  if (!CACHE_BASE || !CACHE_TOKEN) return;
  try {
    const body = Buffer.from(JSON.stringify(state), 'utf8');

    const reserveRes = await fetch(new URL('_apis/artifactcache/caches', CACHE_BASE), {
      method: 'POST',
      headers: { ...CACHE_HEADERS(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, version: CACHE_VERSION, cacheSize: body.length }),
    });
    if (!reserveRes.ok) { warn(`cache reserve status ${reserveRes.status}`); return; }
    const reserveJson = await reserveRes.json();
    const cacheId = reserveJson && reserveJson.cacheId;
    if (!cacheId) return;

    const uploadRes = await fetch(new URL(`_apis/artifactcache/caches/${cacheId}`, CACHE_BASE), {
      method: 'PATCH',
      headers: {
        ...CACHE_HEADERS(),
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes 0-${body.length - 1}/*`,
      },
      body,
    });
    if (!uploadRes.ok) { warn(`cache upload status ${uploadRes.status}`); return; }

    const commitRes = await fetch(new URL(`_apis/artifactcache/caches/${cacheId}`, CACHE_BASE), {
      method: 'POST',
      headers: { ...CACHE_HEADERS(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: body.length }),
    });
    if (!commitRes.ok) { warn(`cache commit status ${commitRes.status}`); return; }
    log(`cache: saved ${key} (${body.length} bytes)`);
  } catch (e) {
    warn(`cache save failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const token = input('slack-token').trim();
  if (!token) { log('slack-token empty; skipping'); return; }
  maskSecret(token);

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventPath || !eventName) { err('GITHUB_EVENT_PATH/GITHUB_EVENT_NAME not set'); return; }
  const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));

  const status = deriveStatus(eventName, payload);
  if (!status) { log(`event ${eventName}.${payload.action} → no status mapping`); return; }

  const emoji = (process.env[`INPUT_EMOJI-${status.toUpperCase()}`] || '').trim();
  if (!emoji) { log(`status ${status} has no configured emoji; skipping`); return; }

  const opposite = FLIP_OPPOSITE[status] || null;
  const oppositeEmoji = opposite
    ? ((process.env[`INPUT_EMOJI-${opposite.toUpperCase()}`] || '').trim() || null)
    : null;

  const isRerun = parseInt(process.env.GITHUB_RUN_ATTEMPT || '1', 10) > 1;
  if (isRerun) log(`run_attempt > 1: skipping flip cleanup for safety`);

  const ctx = prContext(payload);
  if (!ctx) { err('could not derive PR context from payload'); return; }
  const prKey = `${ctx.owner}/${ctx.repo}#${ctx.num}`;

  let state = (await cacheRestore()) || {};
  state.prMatches = state.prMatches || {};

  // Stale sweep at run start.
  const staleCutoff = nowS() - PR_STALE_TTL_S;
  let swept = 0;
  for (const k of Object.keys(state.prMatches)) {
    if ((state.prMatches[k].lastTouched || 0) < staleCutoff) {
      delete state.prMatches[k];
      swept++;
    }
  }
  if (swept > 0) log(`cache: swept ${swept} stale entr${swept === 1 ? 'y' : 'ies'}`);

  try {
    let matches;
    if (state.prMatches[prKey] && state.prMatches[prKey].matches && state.prMatches[prKey].matches.length) {
      matches = state.prMatches[prKey].matches;
      log(`cache hit for ${prKey}: ${matches.length} match(es)`);
    } else {
      await ensureBotUserId(state, token);
      const channels = await ensureChannels(state, token);
      log(`scanning ${Math.min(channels.length, MAX_CHANNELS_PER_RUN)} channel(s) for ${ctx.prUrl}`);
      matches = await discoverMatches(channels, ctx.owner, ctx.repo, ctx.num, token);
      log(`discovery: ${matches.length} match(es) for ${prKey}`);
    }

    if (oppositeEmoji && !isRerun && matches.length) {
      await ensureBotUserId(state, token);
    }

    const survivors = [];
    let reacted = 0;
    for (const m of matches) {
      if (reacted >= REACTIONS_PER_RUN_CAP) {
        warn(`reactions-per-run cap (${REACTIONS_PER_RUN_CAP}) reached; ${matches.length - reacted} skipped`);
        break;
      }
      reacted++;
      const result = await reactToMatch(m, status, emoji, oppositeEmoji, state.botUserId, isRerun, token);
      if (!STALE_MATCH_ERRORS.has(result.error)) survivors.push(m);
    }

    // Cache update for this PR.
    if (status === STATUS_MERGED || status === STATUS_CLOSED) {
      delete state.prMatches[prKey];
    } else if (survivors.length) {
      state.prMatches[prKey] = { matches: survivors, lastTouched: nowS() };
    } else {
      delete state.prMatches[prKey];
    }

    // Safety cap.
    const keys = Object.keys(state.prMatches);
    if (keys.length > MAX_PR_ENTRIES) {
      keys.sort((a, b) => (state.prMatches[a].lastTouched || 0) - (state.prMatches[b].lastTouched || 0));
      const evict = keys.slice(0, keys.length - MAX_PR_ENTRIES);
      for (const k of evict) delete state.prMatches[k];
      warn(`pr-entries safety cap; evicted ${evict.length}`);
    }
  } catch (e) {
    if (e instanceof AuthError) {
      err(`Slack auth error: ${e.code} — exiting cleanly. Refresh the SLACK_TOKEN secret.`);
      return;
    }
    throw e;
  }

  const runId = process.env.GITHUB_RUN_ID || 'norunid';
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  await cacheSave(state, `${CACHE_KEY_PREFIX}${runId}-${runAttempt}`);
}

// pure helpers
export {
  deriveStatus, prContext,
  matchesPullUrl, urlsFromMessage, tokenizeAngles,
  FLIP_OPPOSITE, AUTH_ERRORS, TOLERATED_REACTION_ERRORS, STALE_MATCH_ERRORS,
  AuthError,
  // dynamic surface for fetch-shim tests
  slackCall, ensureBotUserId, ensureChannels, discoverMatches, reactToMatch,
};

export const _test = {
  setFetch(fn) { _fetch = fn; },
  setPaceMs(ms) { _paceMs = ms; },
  resetSlackClient() { lastSlackCallAt = 0; _fetch = null; _paceMs = null; },
};

// Run main only when invoked as the action's entrypoint, not when imported.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { err(e && e.stack || String(e)); process.exit(1); });
}
