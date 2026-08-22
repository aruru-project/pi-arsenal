import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InvalidAzureImageCredentialError,
  MissingAzureImageCredentialError,
  parseAzureImageCredential,
  resolveAzureImageApiKey,
} from "./credential.ts";
import { AZURE_BASE_URL, executeImageGen } from "./imagegen.ts";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("synthetic-test-png"),
]);

async function tempCredential(raw = "export AZURE_IMAGE_API_KEY='test-key'\n") {
  const root = await mkdtemp(join(tmpdir(), "azure-imagegen-credential-"));
  const directory = join(root, "config");
  await mkdir(directory, { mode: 0o700 });
  const file = join(directory, "env");
  await writeFile(file, raw, { mode: 0o600 });
  return { root, directory, file };
}

test("credential reader accepts only a secure exact literal export", async () => {
  const fixture = await tempCredential();
  assert.equal(await resolveAzureImageApiKey({ credentialDirectory: fixture.directory, environment: {} }), "test-key");
  assert.equal(
    await resolveAzureImageApiKey({ credentialDirectory: join(fixture.root, "missing"), environment: { AZURE_IMAGE_API_KEY: "env-key" } }),
    "env-key",
  );

  assert.throws(
    () => parseAzureImageCredential("export AZURE_IMAGE_API_KEY=one\nexport AZURE_IMAGE_API_KEY=two\n"),
    InvalidAzureImageCredentialError,
  );
  assert.throws(
    () => parseAzureImageCredential("export AZURE_IMAGE_API_KEY=ok\nexport EXTRA=nope\n"),
    InvalidAzureImageCredentialError,
  );
  assert.throws(
    () => parseAzureImageCredential("export AZURE_IMAGE_API_KEY=$(command)\n"),
    InvalidAzureImageCredentialError,
  );
});

test("credential reader rejects missing, insecure, and symlinked credentials", async () => {
  const missingRoot = await mkdtemp(join(tmpdir(), "azure-imagegen-missing-"));
  await assert.rejects(
    resolveAzureImageApiKey({ credentialDirectory: join(missingRoot, "none"), environment: {} }),
    MissingAzureImageCredentialError,
  );

  const insecure = await tempCredential();
  await chmod(insecure.file, 0o640);
  await assert.rejects(
    resolveAzureImageApiKey({ credentialDirectory: insecure.directory, environment: {} }),
    InvalidAzureImageCredentialError,
  );

  const linked = await tempCredential();
  const actual = join(linked.root, "actual-env");
  await writeFile(actual, "export AZURE_IMAGE_API_KEY=linked\n", { mode: 0o600 });
  const linkDirectory = join(linked.root, "link-config");
  await mkdir(linkDirectory, { mode: 0o700 });
  await symlink(actual, join(linkDirectory, "env"));
  await assert.rejects(
    resolveAzureImageApiKey({ credentialDirectory: linkDirectory, environment: {} }),
    InvalidAzureImageCredentialError,
  );
});

test("generation sends non-streaming JSON and returns persisted inline PNG", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "azure-imagegen-generation-"));
  const timeoutSignal = new AbortController().signal;
  const timeout = t.mock.method(AbortSignal, "timeout", (delay: number) => {
    assert.equal(delay, 600_000);
    return timeoutSignal;
  });
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
  }) as typeof fetch;

  const result = await executeImageGen(
    { prompt: "a precise test image", size: "1024x1024", quality: "low" },
    root,
    undefined,
    { fetchFn: fakeFetch, apiKeyResolver: async () => "dummy-key", homeDirectory: root, uniqueId: () => "fixed" },
  );

  assert.equal(capturedUrl, `${AZURE_BASE_URL}images/generations`);
  assert.equal(timeout.mock.callCount(), 1);
  assert.equal(capturedInit?.signal, timeoutSignal);
  assert.equal((capturedInit?.headers as Record<string, string>)["Content-Type"], "application/json");
  const body = JSON.parse(capturedInit?.body as string);
  assert.deepEqual(body, {
    model: "gpt-image-2",
    prompt: "a precise test image",
    size: "1024x1024",
    quality: "low",
    n: 1,
    output_format: "png",
  });
  assert.equal("stream" in body, false);
  assert.deepEqual(await readFile(result.details.path), PNG);
  assert.equal(result.details.operation, "generation");
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(result.content[1], { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
});

test("multi-image edit sends ordered files with the image[] field", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-imagegen-edit-"));
  const first = join(root, "first.png");
  const second = join(root, "second.webp");
  await writeFile(first, PNG);
  await writeFile(second, Buffer.concat([Buffer.from("RIFFxxxxWEBP"), Buffer.from("synthetic")]));
  let captured: RequestInit | undefined;
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = init;
    return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
  }) as typeof fetch;

  const result = await executeImageGen(
    { prompt: "use Image 1 and Image 2", image_paths: [first, second] },
    root,
    undefined,
    { fetchFn: fakeFetch, apiKeyResolver: async () => "dummy-key", homeDirectory: root, uniqueId: () => "edit" },
  );

  assert.ok(captured?.body instanceof FormData);
  const form = captured.body as FormData;
  assert.equal(form.get("model"), "gpt-image-2");
  assert.equal(form.get("prompt"), "use Image 1 and Image 2");
  assert.equal(form.get("size"), "auto");
  assert.equal(form.get("quality"), "auto");
  assert.equal(form.getAll("image").length, 0);
  const images = form.getAll("image[]");
  assert.equal(images.length, 2);
  assert.deepEqual(images.map((entry) => (entry as File).name), ["first.png", "second.webp"]);
  assert.equal(result.details.operation, "edit");
});

test("single-image edit keeps the image field", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-imagegen-single-edit-"));
  const input = join(root, "input.png");
  await writeFile(input, PNG);
  let captured: RequestInit | undefined;
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = init;
    return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
  }) as typeof fetch;

  const result = await executeImageGen(
    { prompt: "use Image 1", image_paths: [input] },
    root,
    undefined,
    { fetchFn: fakeFetch, apiKeyResolver: async () => "dummy-key", homeDirectory: root, uniqueId: () => "single-edit" },
  );

  assert.ok(captured?.body instanceof FormData);
  const form = captured.body as FormData;
  assert.equal(form.getAll("image[]").length, 0);
  const images = form.getAll("image");
  assert.equal(images.length, 1);
  assert.equal((images[0] as File).name, "input.png");
  assert.equal(result.details.operation, "edit");
});

test("explicit outputs never overwrite and are checked before fetch", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-imagegen-output-"));
  const output = join(root, "exists.png");
  await writeFile(output, Buffer.from("original"));
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
  }) as typeof fetch;

  await assert.rejects(
    executeImageGen(
      { prompt: "do not run", output_path: output },
      root,
      undefined,
      { fetchFn: fakeFetch, apiKeyResolver: async () => "dummy-key" },
    ),
    /output already exists/,
  );
  assert.equal(calls, 0);
  assert.equal((await readFile(output, "utf8")), "original");
});

test("API errors are bounded and credentials are redacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-imagegen-error-"));
  const secret = "dummy-secret-that-must-not-escape";
  const fakeFetch = (async () => new Response(
    JSON.stringify({ error: { message: `${secret}:${"x".repeat(10_000)}` } }),
    { status: 400 },
  )) as typeof fetch;

  await assert.rejects(
    executeImageGen(
      { prompt: "fail safely" },
      root,
      undefined,
      { fetchFn: fakeFetch, apiKeyResolver: async () => secret },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.length <= 2100);
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});
