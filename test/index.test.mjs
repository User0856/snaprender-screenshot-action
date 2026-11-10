import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInputs, fileNameFor, errorFrom, escapeData, request, captureAll, markdownFor, summaryFor, run } from '../src/index.mjs';

const env = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]));
const noWait = async () => {};

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const r = handler(url, JSON.parse(init.body), calls.length);
    const body = typeof r.body === 'string' ? Buffer.from(r.body) : (r.body ?? Buffer.alloc(0));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (h) => (r.headers ?? {})[h.toLowerCase()] ?? null },
      text: async () => body.toString('utf8'),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
  };
  impl.calls = calls;
  return impl;
}

test('parseInputs: defaults and list parsing', () => {
  const cfg = parseInputs(env({ 'api-key': 'k', urls: 'https://a.example\n\n# comment\n https://b.example/x \n' }));
  assert.deepEqual(cfg.urls, ['https://a.example', 'https://b.example/x']);
  assert.equal(cfg.options.format, 'png');
  assert.equal(cfg.options.block_ads, true);
  assert.equal(cfg.options.block_cookie_banners, true);
  assert.equal(cfg.options.full_page, false);
  assert.equal(cfg.outputDir, 'snaprender-screenshots');
  assert.equal(cfg.failOnError, true);
});

test('parseInputs: device drops width and height', () => {
  const cfg = parseInputs(env({ 'api-key': 'k', urls: 'https://a.example', device: 'iphone_15_pro', width: '1440', height: '900' }));
  assert.equal(cfg.options.device, 'iphone_15_pro');
  assert.equal(cfg.options.width, undefined);
  assert.equal(cfg.options.height, undefined);
});

test('parseInputs: clear errors for bad input', () => {
  assert.throws(() => parseInputs(env({ urls: 'https://a.example' })), /api-key is empty/);
  assert.throws(() => parseInputs(env({ 'api-key': 'k', urls: '' })), /urls is empty/);
  assert.throws(() => parseInputs(env({ 'api-key': 'k', urls: 'ftp://a.example' })), /http:\/\/ or https:\/\//);
  assert.throws(() => parseInputs(env({ 'api-key': 'k', urls: 'not a url' })), /not a valid URL/);
  assert.throws(() => parseInputs(env({ 'api-key': 'k', urls: 'https://a.example', format: 'gif' })), /format must be one of/);
  assert.throws(() => parseInputs(env({ 'api-key': 'k', urls: 'https://a.example', 'full-page': 'yes' })), /full-page must be true or false/);
  assert.throws(() => parseInputs(env({ 'api-key': 'k', urls: 'https://a.example', width: '100' })), /width must be a whole number from 320/);
  const many = Array.from({ length: 51 }, (_, i) => `https://a.example/${i}`).join('\n');
  assert.throws(() => parseInputs(env({ 'api-key': 'k', urls: many })), /limit is 50/);
});

test('fileNameFor: readable and unique', () => {
  const taken = new Set();
  assert.equal(fileNameFor('https://example.com/', 'png', taken), 'example.com.png');
  assert.equal(fileNameFor('https://example.com/pricing?x=1', 'jpeg', taken), 'example.com_pricing.jpg');
  assert.equal(fileNameFor('https://example.com', 'png', taken), 'example.com-2.png');
});

test('errorFrom: SnapRender body or HTTP status', () => {
  assert.equal(errorFrom(422, '{"error":{"code":"TARGET_UNREACHABLE","message":"The target website could not be reached.","status":422}}'), 'TARGET_UNREACHABLE: The target website could not be reached.');
  assert.equal(errorFrom(502, 'error code: 502'), 'HTTP 502: error code: 502');
});

test('escapeData: newlines and percent cannot inject workflow commands', () => {
  assert.equal(escapeData('a%b\r\n::error::x'), 'a%25b%0D%0A::error::x');
});

test('request: retries a per-minute 429 after Retry-After, then succeeds', async () => {
  const waits = [];
  const f = fakeFetch((_u, _b, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '3' }, body: '{"error":{"code":"RATE_LIMITED","message":"slow down"}}' } : { status: 200, body: 'PNGDATA' }));
  const res = await request(f, '/v1/screenshot', 'k', { url: 'https://a.example' }, { wait: async (ms) => waits.push(ms) });
  assert.equal(res.ok, true);
  assert.equal(res.body.toString(), 'PNGDATA');
  assert.deepEqual(waits, [3000]);
  assert.equal(f.calls[0].headers['X-API-Key'], 'k');
});

test('request: monthly quota 429 is not retried', async () => {
  const f = fakeFetch(() => ({ status: 429, body: '{"error":{"code":"QUOTA_EXCEEDED","message":"Monthly captures used up."}}' }));
  const res = await request(f, '/v1/screenshot', 'k', {}, { wait: noWait });
  assert.equal(res.ok, false);
  assert.equal(f.calls.length, 1);
});

test('captureAll + run: writes files, outputs, summary; failures reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-action-'));
  const out = join(dir, 'out.txt');
  const summary = join(dir, 'summary.md');
  const f = fakeFetch((url, body) => {
    if (url.endsWith('/v1/screenshot/sign')) return { status: 200, body: JSON.stringify({ signed_url: `https://app.snap-render.com/v1/screenshot/render?u=${encodeURIComponent(body.url)}` }) };
    if (body.url.includes('dead')) return { status: 422, body: '{"error":{"code":"TARGET_UNREACHABLE","message":"Could not be reached.","status":422}}' };
    return { status: 200, body: 'IMG' };
  });
  const logs = [];
  const code = await run(
    { ...env({ 'api-key': 'secret-key', urls: 'https://ok.example\nhttps://dead.example', 'output-dir': join(dir, 'shots'), 'signed-urls': 'true' }), GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
    { fetchImpl: f, wait: noWait, log: (l) => logs.push(l) },
  );
  assert.equal(code, 1, 'fails by default when a URL fails');
  assert.ok(logs[0].startsWith('::add-mask::secret-key'));
  assert.ok(existsSync(join(dir, 'shots', 'ok.example.png')));
  const outputs = readFileSync(out, 'utf8');
  assert.match(outputs, /count<<.*\n1\n/);
  assert.match(outputs, /failed<<.*\n1\n/);
  assert.match(outputs, /<img src="https:\/\/app\.snap-render\.com\/v1\/screenshot\/render\?u=https%3A%2F%2Fok\.example"/);
  assert.match(outputs, /Not captured: TARGET_UNREACHABLE: Could not be reached\./);
  const sum = readFileSync(summary, 'utf8');
  assert.match(sum, /1 of 2 captured/);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/sign')).length, 1, 'no signed URL for the failed capture');
  assert.equal(f.calls[0].body.response_type, 'binary');
});

test('signed URLs carry the commit in the fragment so each commit gets a fresh image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-action-'));
  const signedBodies = [];
  const f = fakeFetch((url, body) => {
    if (url.endsWith('/v1/screenshot/sign')) { signedBodies.push(body); return { status: 200, body: JSON.stringify({ signed_url: 'https://app.snap-render.com/s' }) }; }
    return { status: 200, body: 'IMG' };
  });
  const base = { 'api-key': 'k', urls: 'https://preview.example/\nhttps://spa.example/#/pricing', 'output-dir': join(dir, 's'), 'signed-urls': 'true' };
  await run({ ...env(base), GITHUB_SHA: 'abcdef1234567890' }, { fetchImpl: f, wait: noWait, log: () => {} });
  assert.equal(signedBodies[0].url, 'https://preview.example/#sr-abcdef1');
  assert.equal(signedBodies[1].url, 'https://spa.example/#/pricing', 'existing fragments are left alone');
  assert.equal(f.calls.find((c) => !c.url.endsWith('/sign')).body.url, 'https://preview.example/', 'the capture itself uses the plain URL');
  signedBodies.length = 0;
  await run({ ...env({ ...base, 'signed-url-per-commit': 'false' }), GITHUB_SHA: 'abcdef1234567890' }, { fetchImpl: f, wait: noWait, log: () => {} });
  assert.equal(signedBodies[0].url, 'https://preview.example/');
  signedBodies.length = 0;
  await run(env(base), { fetchImpl: f, wait: noWait, log: () => {} });
  assert.equal(signedBodies[0].url, 'https://preview.example/', 'no commit outside Actions');
});

test('run: fail-on-error false keeps the step green', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-action-'));
  const f = fakeFetch(() => ({ status: 422, body: '{"error":{"code":"TARGET_SSL_ERROR","message":"Bad certificate."}}' }));
  const code = await run(env({ 'api-key': 'k', urls: 'https://x.example', 'output-dir': join(dir, 's'), 'fail-on-error': 'false' }), { fetchImpl: f, wait: noWait, log: () => {} });
  assert.equal(code, 0);
});

test('markdown and summary escape nothing dangerous and list every URL', () => {
  const results = [{ url: 'https://a.example', file: 'shots/a.png', bytes: 2048, error: null, signed_url: null }, { url: 'https://b.example', file: null, bytes: 0, error: 'X: a|b', signed_url: null }];
  assert.match(markdownFor(results), /Saved as `shots\/a.png`/);
  assert.match(summaryFor(results), /Failed: X: a\\\|b/);
});
