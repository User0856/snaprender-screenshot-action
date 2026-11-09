// SnapRender Screenshot action. No dependencies: Node 24 provides fetch, and the workflow
// commands (inputs, outputs, masking, summary) are plain environment variables and files.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = (process.env.SNAPRENDER_BASE_URL || 'https://app.snap-render.com').replace(/\/+$/, '');
const FORMATS = ['png', 'jpeg', 'webp', 'pdf'];
const DEVICES = ['iphone_14', 'iphone_15_pro', 'pixel_7', 'ipad_pro', 'macbook_pro'];
const MAX_URLS = 50;
const SIGNED_URL_TTL = 7 * 24 * 3600;

export function getInput(env, name) {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

function bool(value, name) {
  const v = value.toLowerCase();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  throw new Error(`${name} must be true or false, got "${value}".`);
}

function int(value, name, min, max) {
  if (value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${value}".`);
  return n;
}

/** Read and validate every input. Throws an Error with a plain explanation on bad input. */
export function parseInputs(env) {
  const apiKey = getInput(env, 'api-key');
  if (!apiKey) throw new Error('api-key is empty. Add your SnapRender API key as a repository secret and pass it as api-key: ${{ secrets.SNAPRENDER_API_KEY }}.');

  const urls = getInput(env, 'urls').split(/\r?\n/).map((u) => u.trim()).filter((u) => u && !u.startsWith('#'));
  if (urls.length === 0) throw new Error('urls is empty. List at least one URL, one per line.');
  if (urls.length > MAX_URLS) throw new Error(`urls has ${urls.length} entries; the limit is ${MAX_URLS} per step.`);
  for (const u of urls) {
    let parsed;
    try { parsed = new URL(u); } catch { throw new Error(`"${u}" is not a valid URL.`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`"${u}" must start with http:// or https://.`);
  }

  const format = (getInput(env, 'format') || 'png').toLowerCase();
  if (!FORMATS.includes(format)) throw new Error(`format must be one of ${FORMATS.join(', ')}, got "${format}".`);
  const device = getInput(env, 'device').toLowerCase();
  if (device && !DEVICES.includes(device)) throw new Error(`device must be one of ${DEVICES.join(', ')}, got "${device}".`);

  return {
    apiKey,
    urls,
    options: {
      format,
      full_page: bool(getInput(env, 'full-page'), 'full-page'),
      device: device || undefined,
      width: device ? undefined : int(getInput(env, 'width'), 'width', 320, 3840),
      height: device ? undefined : int(getInput(env, 'height'), 'height', 200, 10000),
      dark_mode: bool(getInput(env, 'dark-mode'), 'dark-mode'),
      block_ads: bool(getInput(env, 'block-ads') || 'true', 'block-ads'),
      block_cookie_banners: bool(getInput(env, 'block-cookie-banners') || 'true', 'block-cookie-banners'),
      delay: int(getInput(env, 'delay'), 'delay', 0, 10000),
      hide_selectors: getInput(env, 'hide-selectors') || undefined,
      quality: int(getInput(env, 'quality'), 'quality', 1, 100),
    },
    outputDir: getInput(env, 'output-dir') || 'snaprender-screenshots',
    signedUrls: bool(getInput(env, 'signed-urls'), 'signed-urls'),
    failOnError: bool(getInput(env, 'fail-on-error') || 'true', 'fail-on-error'),
  };
}

/** Readable, unique file name per URL: example.com_pricing.png, then example.com_pricing-2.png. */
export function fileNameFor(url, format, taken) {
  const { hostname, pathname } = new URL(url);
  let base = (hostname + pathname).replace(/\/+$/, '').replace(/[^a-zA-Z0-9.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'page';
  const ext = format === 'jpeg' ? 'jpg' : format;
  let name = `${base}.${ext}`;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}.${ext}`;
  taken.add(name);
  return name;
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** "CODE: message" from a SnapRender error body, or the HTTP status when the body is not ours. */
export function errorFrom(status, text) {
  try {
    const err = JSON.parse(text)?.error;
    if (err?.code && err?.message) return `${err.code}: ${err.message}`;
  } catch { /* not JSON */ }
  return `HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ''}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Escape text for a workflow command (::warning::, ::error::) so newlines and % cannot break or inject commands. */
export function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * POST with retries on rate limits (429 never uses captures) and on network errors.
 * Returns { ok, status, body (Buffer), text } without throwing for HTTP errors.
 */
export async function request(fetchImpl, path, apiKey, payload, { retries = 4, wait = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'snaprender-screenshot-action/1' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      if (attempt < 1) { await wait(2000); continue; }
      return { ok: false, status: 0, text: `Network error: ${e.message}` };
    }
    if (res.status === 429 && attempt < retries) {
      const text = await res.text();
      let quota = false;
      try { quota = JSON.parse(text)?.error?.code === 'QUOTA_EXCEEDED'; } catch { /* ignore */ }
      if (quota) return { ok: false, status: 429, text };
      const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 15, 65);
      await wait(retryAfter * 1000);
      continue;
    }
    if (!res.ok) return { ok: false, status: res.status, text: await res.text() };
    return { ok: true, status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  }
}

export async function captureAll(cfg, { fetchImpl = fetch, wait = sleep, log = console.log } = {}) {
  mkdirSync(cfg.outputDir, { recursive: true });
  const taken = new Set();
  const results = [];
  for (const url of cfg.urls) {
    const result = { url, file: null, bytes: 0, error: null, signed_url: null };
    const res = await request(fetchImpl, '/v1/screenshot', cfg.apiKey, clean({ url, ...cfg.options, response_type: 'binary' }), { wait });
    if (res.ok) {
      const file = join(cfg.outputDir, fileNameFor(url, cfg.options.format, taken));
      writeFileSync(file, res.body);
      result.file = file;
      result.bytes = res.body.length;
      log(`Captured ${url} -> ${file} (${Math.round(res.body.length / 1024)} KB)`);
    } else {
      result.error = errorFrom(res.status, res.text);
      log(`::warning title=SnapRender::${escapeData(`${url}: ${result.error}`)}`);
    }
    if (cfg.signedUrls && !result.error) {
      const signed = await request(fetchImpl, '/v1/screenshot/sign', cfg.apiKey, clean({ url, ...cfg.options, expires_in: SIGNED_URL_TTL }), { wait });
      if (signed.ok) {
        try { result.signed_url = JSON.parse(signed.body.toString('utf8')).signed_url ?? null; } catch { /* leave null */ }
      } else {
        log(`::warning title=SnapRender::${escapeData(`Could not sign ${url}: ${errorFrom(signed.status, signed.text)}`)}`);
      }
    }
    results.push(result);
  }
  return results;
}

export function markdownFor(results) {
  const rows = results.map((r) => {
    if (r.error) return `**${r.url}**\n\nNot captured: ${r.error}`;
    if (r.signed_url) return `**${r.url}**\n\n<img src="${r.signed_url}" width="600" alt="Screenshot of ${r.url}">`;
    return `**${r.url}**\n\nSaved as \`${r.file}\``;
  });
  return rows.join('\n\n');
}

export function summaryFor(results) {
  const ok = results.filter((r) => !r.error).length;
  const lines = [`### SnapRender: ${ok} of ${results.length} captured`, '', '| URL | Result |', '| --- | --- |'];
  for (const r of results) {
    const cell = r.error ? `Failed: ${r.error.replace(/\|/g, '\\|')}` : `\`${r.file}\` (${Math.round(r.bytes / 1024)} KB)`;
    lines.push(`| ${r.url} | ${cell} |`);
  }
  return lines.join('\n') + '\n';
}

function setOutput(env, name, value) {
  if (!env.GITHUB_OUTPUT) return;
  const delimiter = `snaprender_${Math.random().toString(36).slice(2)}`;
  appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export async function run(env = process.env, deps = {}) {
  const log = deps.log ?? console.log;
  let cfg;
  try {
    cfg = parseInputs(env);
  } catch (e) {
    log(`::error title=SnapRender::${escapeData(e.message)}`);
    return 1;
  }
  log(`::add-mask::${escapeData(cfg.apiKey)}`);
  const results = await captureAll(cfg, { ...deps, log });
  const failed = results.filter((r) => r.error).length;
  setOutput(env, 'files', JSON.stringify(results.filter((r) => r.file).map((r) => r.file)));
  setOutput(env, 'count', String(results.length - failed));
  setOutput(env, 'failed', String(failed));
  setOutput(env, 'results', JSON.stringify(results));
  setOutput(env, 'markdown', markdownFor(results));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summaryFor(results));
  if (failed && cfg.failOnError) {
    log(`::error title=SnapRender::${failed} of ${results.length} URLs could not be captured. Set fail-on-error: false to continue anyway.`);
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run().then((code) => { process.exitCode = code; });
}
