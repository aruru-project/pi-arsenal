import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import https from 'node:https';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Prefer the packaged source; use the installed extension when running in its original workspace.
const packagedSource = resolve(dirname(fileURLToPath(import.meta.url)), '../../extensions/music-gen.ts');
const sourcePath = existsSync(packagedSource) ? packagedSource : resolve(homedir(), '.pi/agent/extensions/music-gen.ts');
// Integration uses the real Pi loader, never a fake registerTool. A custom runtime can supply its loader path.
const loaderPath = process.env.MUSIC_GEN_TEST_LOADER ?? resolve(homedir(), '.local/share/alu-dock/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js');
let loadExtensions;
let moduleExports;
if (existsSync(loaderPath)) {
  ({ loadExtensions } = await import(pathToFileURL(loaderPath).href));
  const require = createRequire(loaderPath);
  const { createJiti } = require('jiti');
  const jiti = createJiti(loaderPath, { alias: { typebox: require.resolve('typebox') } });
  moduleExports = await jiti.import(sourcePath);
} else {
  // Native Node TS support plus typebox are sufficient for filesystem/credential tests.
  moduleExports = await import(pathToFileURL(sourcePath).href);
}
const { parseMusicCredential, resolveMusicApiKey } = moduleExports;
const runFile = promisify(execFile);

async function fixtureAcl(path, broad = false) {
  if (process.platform !== 'win32') return;
  const encoded = Buffer.from(path, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference='Stop'
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$acl=Get-Acl -LiteralPath $p
if (${broad ? '$true' : '$false'}) {
  $sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow')
  $acl.AddAccessRule($rule)
} else {
  $acl.SetAccessRuleProtection($true,$false)
  foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($rule)}
  $inherit=if((Get-Item -LiteralPath $p).PSIsContainer){'ContainerInherit, ObjectInherit'}else{'None'}
  foreach($who in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')) {
    $sid=[Security.Principal.SecurityIdentifier]::new($who)
    $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow')
    $acl.AddAccessRule($rule)
  }
}
Set-Acl -LiteralPath $p -AclObject $acl
`;
  await runFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout: 10000, windowsHide: true });
}
const endpoint = 'https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests';
const audio = Buffer.from('ID3-offline-audio-fixture');

test('music_gen offline integration with actual Pi loader', { skip: !loadExtensions && 'Pi loader unavailable; native credential tests still run' }, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'gmi-music-'));
  const extensions = resolve(root, 'agent/extensions');
  const cwd = resolve(root, 'active-workspace');
  const credentialDirectory = resolve(root, 'alu-musicgen');
  const config = resolve(credentialDirectory, 'env');
  const output = resolve(cwd, 'test/gmi-music');
  await mkdir(extensions, { recursive: true });
  await mkdir(cwd);
  const extension = resolve(extensions, 'music-gen.ts');
  // Only the temporary copy substitutes defaults; never consult real credentials.
  const source = await readFile(sourcePath, 'utf8');
  assert.ok(source.includes('options.environment ?? process.env'));
  assert.ok(source.includes('join(homedir(), ".config", "alu-musicgen")'));
  await writeFile(extension, source
    .replace('options.environment ?? process.env', 'options.environment ?? {}')
    .replace('join(homedir(), ".config", "alu-musicgen")', JSON.stringify(credentialDirectory)));
  await mkdir(credentialDirectory, { mode: 0o700 });
  await fixtureAcl(credentialDirectory);
  await writeFile(config, "export GMI_API_KEY=''\n", { mode: 0o600 });
  // Obsolete JSON must not be used, even if populated beside the extension.
  await writeFile(resolve(root, 'agent/music-gen.config.json'), '{"apiKey":"obsolete-fake-key"}');
  const calls = [];
  let responses = [];
  let mediaStatus = 200;
  let mediaHeaders = {};
  let mediaChunks = [audio];
  let address = '8.8.8.8';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    assert.equal(options.headers.Authorization, 'Bearer offline-key');
    assert.equal(options.redirect, 'error');
    const next = responses.shift();
    if (typeof next === 'function') return next(options);
    assert.ok(next, 'unexpected API call');
    return Response.json(next);
  });
  t.mock.method(dns, 'lookup', (_host, _options, callback) => callback(null, [{ address, family: 4 }]));
  t.mock.method(https, 'get', (url, options, callback) => {
    calls.push({ media: true, url: String(url), options });
    assert.equal(options.headers, undefined, 'audio must not carry authorization');
    assert.equal(options.agent, false);
    const request = new EventEmitter();
    queueMicrotask(() => options.lookup(url.hostname, { all: true }, (error) => {
      if (error) return request.emit('error', error);
      const response = Readable.from(mediaChunks);
      response.statusCode = mediaStatus;
      response.headers = { 'content-type': 'audio/mpeg', ...mediaHeaders };
      callback(response);
    }));
    return request;
  });
  try {
    const loaded = await loadExtensions([extension], cwd);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const tool = loaded.extensions[0].tools.get('music_gen').definition;
    assert.equal(tool.parameters.type, 'object');
    const run = (params, signal, update) => tool.execute('offline-call', params, signal, update, { cwd });
    const input = { prompt: 'soft piano', lyrics: '[Inst]' };
    await t.test('blank key and invalid lyrics refuse before networking', async () => {
      await assert.rejects(run(input), /Invalid music credential/);
      await assert.rejects(run({ prompt: '', lyrics: '' }), /Supply lyrics/);
      assert.equal(calls.length, 0);
      await writeFile(config, "export GMI_API_KEY='offline-key'\n");
    });
    await t.test('submit, immediate query, download and active cwd path', async () => {
      responses = [{ request_id: 'req-1', status: 'success' }, { status: 'success', outcome: { audio_url: 'https://storage.googleapis.com/fake.mp3' } }];
      const updates = [];
      const result = await run(input, undefined, (value) => updates.push(value));
      assert.equal(calls[0].url, endpoint);
      assert.equal(calls[0].method, 'POST');
      assert.deepEqual(JSON.parse(calls[0].body), { model: 'minimax-music-3.0', payload: { ...input, sample_rate: 44100, bitrate: 256000, format: 'mp3' } });
      assert.equal(calls[1].url, `${endpoint}/req-1`);
      assert.equal(calls[1].method, 'GET');
      assert.equal(result.details.request_id, 'req-1');
      assert.equal(updates[0].details.request_id, 'req-1');
      assert.equal(dirname(result.details.path), output);
      assert.deepEqual(await readFile(result.details.path), audio);
    });
    await t.test('resume media_urls without POST; unique files', async () => {
      const start = calls.length;
      responses = [{ status: 'success', outcome: { media_urls: [{ url: 'https://storage.googleapis.com/fake.mp3' }] } }];
      await run({ request_id: 'req-1' });
      assert.deepEqual(calls.slice(start).filter(c => !c.media).map(c => c.method), ['GET']);
      assert.equal((await readdir(output)).length, 2);
    });
    await t.test('submit failure is sanitized and never retried', async () => {
      const start = calls.length;
      responses = [() => { throw new Error('offline-key raw-provider-body'); }];
      await assert.rejects(run(input), e => /no request ID/.test(e.message) && !/offline-key|raw-provider-body/.test(e.message));
      assert.equal(calls.length - start, 1);
    });
    await t.test('cancel before submit and after request ID, no re-POST', async () => {
      let start = calls.length;
      const before = new AbortController(); before.abort();
      await assert.rejects(run(input, before.signal), /cancelled/);
      assert.equal(calls.length, start);
      const during = new AbortController();
      responses = [{ request_id: 'req-cancel', status: 'queued' }];
      await assert.rejects(run(input, during.signal, () => during.abort()), /req-cancel.*do not resubmit/);
      assert.equal(calls.length - start, 1);
    });
    await t.test('timeout after ID preserves recovery and does not resubmit', async () => {
      const start = calls.length;
      const deadline = new AbortController();
      const timeoutMock = t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
      responses = [{ request_id: 'req-timeout', status: 'queued' }, () => { deadline.abort(); throw new Error('timeout'); }];
      try { await assert.rejects(run(input), /timed out.*req-timeout/); }
      finally { timeoutMock.mock.restore(); }
      assert.deepEqual(calls.slice(start).map(c => c.method), ['POST', 'GET']);
    });
    await t.test('failed query and unsafe audio URLs retain request ID', async () => {
      responses = [{ status: 'failed', error: 'offline-key raw-provider-body' }];
      await assert.rejects(run({ request_id: 'req-1' }), /generation failed.*req-1/);
      for (const url of ['http://example.com/a.mp3', 'https://127.0.0.1/a', 'https://user:pass@example.com/a']) {
        responses = [{ outcome: { audio_url: url } }];
        await assert.rejects(run({ request_id: 'req-1' }), /Unsafe audio URL.*req-1/);
      }
      address = '10.0.0.1';
      responses = [{ outcome: { audio_url: 'https://example.com/a' } }];
      await assert.rejects(run({ request_id: 'req-1' }), /Non-public audio host/);
      address = '8.8.8.8';
    });
    await t.test('redirect, oversized, and empty audio rejected; partial files removed', async () => {
      for (const kind of ['redirect', 'oversized', 'stream-oversized', 'empty']) {
        mediaStatus = kind === 'redirect' ? 302 : 200;
        mediaHeaders = kind === 'oversized' ? { 'content-length': '104857601' } : {};
        mediaChunks = kind === 'empty' ? [] : kind === 'stream-oversized' ? Array(101).fill(Buffer.alloc(1024 * 1024)) : [audio];
        responses = [{ outcome: { medias: [{ type: 'audio', url: 'https://example.com/a' }] } }];
        await assert.rejects(run({ request_id: 'req-1' }), /Audio download failed|exceeds 100 MiB|was empty/);
      }
      assert.equal((await readdir(output)).length, 2);
      assert.ok((await readdir(output)).every(name => name.endsWith('.mp3')));
    });
    await t.test('same registered tool follows a new invocation cwd', async () => {
      const secondCwd = resolve(root, 'second-workspace');
      mediaStatus = 200; mediaHeaders = {}; mediaChunks = [audio];
      responses = [{ outcome: { audio_url: 'https://example.com/a' } }];
      const result = await tool.execute('second-call', { request_id: 'req-1' }, undefined, undefined, { cwd: secondCwd });
      assert.equal(dirname(result.details.path), resolve(secondCwd, 'test/gmi-music'));
      assert.deepEqual(await readFile(result.details.path), audio);
    });
    assert.equal(responses.length, 0);
  } finally {
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('credential literal parser accepts Azure-style literals, rejects shell syntax', () => {
  for (const literal of ["'offline-key'", '"offline-key"', 'offline-key']) {
    assert.equal(parseMusicCredential(`# comment\r\n\n export GMI_API_KEY = ${literal} \r\n`), 'offline-key');
  }
  assert.equal(parseMusicCredential("export GMI_API_KEY='  offline-key  '"), 'offline-key');
  for (const raw of [
    '', '# comment', "export GMI_API_KEY=''", 'export GMI_API_KEY="  "',
    'GMI_API_KEY=offline-key', 'export OTHER_KEY=offline-key',
    'export GMI_API_KEY=one\nexport GMI_API_KEY=two',
    'export GMI_API_KEY=one\necho nope',
    "export GMI_API_KEY='$(echo nope)'", "export GMI_API_KEY='`echo nope`'",
    'export GMI_API_KEY="$HOME"', 'export GMI_API_KEY=${HOME}',
    'export GMI_API_KEY="escaped\\value"', "export GMI_API_KEY='one'; echo nope",
    "export GMI_API_KEY='one' # trailing comment", "export GMI_API_KEY='unclosed",
    "export GMI_API_KEY='one\ntwo'", 'source other-file',
  ]) {
    assert.throws(() => parseMusicCredential(raw), /Invalid music credential/, raw);
  }
});

test('credential precedence and private file validation use only temporary fixtures', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'gmi-credential-'));
  const credentialDirectory = resolve(root, 'alu-musicgen');
  const file = resolve(credentialDirectory, 'env');
  const options = { credentialDirectory, environment: {} };
  const valid = "export GMI_API_KEY='file-fake-key'\n";
  try {
    await assert.rejects(resolveMusicApiKey(options), /Set GMI_API_KEY/);
    assert.equal(await resolveMusicApiKey({ ...options, environment: { GMI_API_KEY: ' env-fake-key ' } }), 'env-fake-key');
    await mkdir(credentialDirectory, { mode: 0o700 });
    await fixtureAcl(credentialDirectory);
    await assert.rejects(resolveMusicApiKey(options), /Set GMI_API_KEY/);
    await writeFile(file, valid, { mode: 0o600 });
    assert.equal(await resolveMusicApiKey(options), 'file-fake-key');
    assert.equal(await resolveMusicApiKey({ ...options, environment: { GMI_API_KEY: ' \t ' } }), 'file-fake-key');
    await t.test('nonempty environment bypasses invalid file; no fallback for invalid env', async () => {
      await writeFile(file, 'invalid file');
      assert.equal(await resolveMusicApiKey({ ...options, environment: { GMI_API_KEY: 'env-fake-key' } }), 'env-fake-key');
      await assert.rejects(resolveMusicApiKey({ ...options, environment: { GMI_API_KEY: 'bad\nkey' } }), /Invalid music credential/);
      await assert.rejects(resolveMusicApiKey(options), /Invalid music credential/);
      await writeFile(file, valid);
    });
    await t.test('directory/file modes and owner must match', { skip: process.platform === 'win32' }, async () => {
      for (const mode of [0o755, 0o750, 0o500]) {
        await chmod(credentialDirectory, mode);
        await assert.rejects(resolveMusicApiKey(options), /Invalid music credential/);
      }
      await chmod(credentialDirectory, 0o700);
      for (const mode of [0o644, 0o640, 0o400]) {
        await chmod(file, mode);
        await assert.rejects(resolveMusicApiKey(options), /Invalid music credential/);
      }
      await chmod(file, 0o600);
      const uid = process.getuid();
      for (const mismatch of ['directory', 'file']) {
        let checks = 0;
        const uidMock = t.mock.method(process, 'getuid', () => mismatch === 'directory' || checks++ > 0 ? uid + 1 : uid);
        try { await assert.rejects(resolveMusicApiKey(options), /Invalid music credential/); }
        finally { uidMock.mock.restore(); }
      }
    });
    await t.test('Windows rejects files or directories readable by other users', { skip: process.platform !== 'win32' }, async () => {
      for (const path of [credentialDirectory, file]) {
        await fixtureAcl(path, true);
        await assert.rejects(resolveMusicApiKey(options), /Invalid music credential/);
        await fixtureAcl(path);
        assert.equal(await resolveMusicApiKey(options), 'file-fake-key');
      }
    });
    await t.test('symlinks and non-regular files rejected', async () => {
      const linkDirectory = resolve(root, 'linked-dir');
      await symlink(credentialDirectory, linkDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(resolveMusicApiKey({ ...options, credentialDirectory: linkDirectory }), /Invalid music credential/);
      const target = resolve(root, 'target');
      await writeFile(target, valid, { mode: 0o600 });
      await rm(file);
      try {
        await symlink(target, file, 'file');
        await assert.rejects(resolveMusicApiKey(options), /Invalid music credential/);
        await rm(file);
      } catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
        t.diagnostic('File symlink privilege unavailable; directory junction and non-file checks remain active.');
      }
      await mkdir(file, { mode: 0o600 });
      await assert.rejects(resolveMusicApiKey(options), /Invalid music credential/);
      await rm(file, { recursive: true });
      await writeFile(file, valid, { mode: 0o600 });
    });
    await t.test('16 KiB boundary, invalid UTF-8 and blank key rejected', async () => {
      await writeFile(file, valid + '#' + 'x'.repeat(16 * 1024 - Buffer.byteLength(valid) - 1));
      assert.equal(await resolveMusicApiKey(options), 'file-fake-key');
      await writeFile(file, Buffer.alloc(16 * 1024 + 1, 0x20));
      await assert.rejects(resolveMusicApiKey(options), /Invalid music credential/);
      await writeFile(file, Buffer.from([0xff]));
      await assert.rejects(resolveMusicApiKey(options), /Invalid music credential/);
      await writeFile(file, "export GMI_API_KEY=''\n");
      await assert.rejects(resolveMusicApiKey(options), /Invalid music credential/);
    });
  } finally {
    await chmod(credentialDirectory, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
