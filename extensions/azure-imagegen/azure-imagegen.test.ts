import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  if (process.platform === "win32") {
    // Windows chmod does not create a private ACL. Secure only these dummy
    // fixtures explicitly; the host Temp folder may grant other accounts access.
    const paths = Buffer.from(JSON.stringify([directory, file])).toString("base64");
    const script = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$paths=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${paths}')))
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($path in $paths) {
  if((Get-Item -LiteralPath $path).PSIsContainer) {
    $acl=New-Object Security.AccessControl.DirectorySecurity
  } else {
    $acl=New-Object Security.AccessControl.FileSecurity
  }
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner($owner)
  foreach($sid in @($owner.Value,'S-1-5-18','S-1-5-32-544')) {
    $identity=New-Object Security.Principal.SecurityIdentifier($sid)
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  }
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
  if (process.platform === "win32") {
    // This is a generated dummy fixture, never the user's credential store.
    execFileSync("icacls.exe", [insecure.file, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
  } else {
    await chmod(insecure.file, 0o640);
  }
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

test("generation defaults to low quality and returns a persisted inline PNG", async (t) => {
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
    { prompt: "a precise test image", size: "1024x1024" },
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
  assert.equal(form.get("quality"), "low");
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
      { fetchFn: fakeFetch, apiKeyResolver: async () => "dummy-key", homeDirectory: root },
    ),
    /output already exists/,
  );
  assert.equal(calls, 0);
  assert.equal((await readFile(output, "utf8")), "original");
  await assert.rejects(readFile(join(root, ".pi", "agent", "imagegen-usage.jsonl")), { code: "ENOENT" });
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
      { fetchFn: fakeFetch, apiKeyResolver: async () => secret, homeDirectory: root },
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

test("Sunburst generation forwards max quality and transparent background", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-imagegen-sunburst-"));
  let body: Record<string, unknown> | undefined;
  const result = await executeImageGen(
    {
      prompt: "a transparent hair texture",
      model: "gpt-image-2.5-sunburst",
      quality: "max",
      background: "transparent",
      size: "2880x2880",
    },
    root,
    undefined,
    {
      apiKeyResolver: async () => "dummy-key",
      homeDirectory: root,
      fetchFn: (async (url, init) => {
        assert.equal(String(url), `${AZURE_BASE_URL}images/generations`);
        body = JSON.parse(init?.body as string);
        return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
      }) as typeof fetch,
    },
  );
  assert.equal(body?.model, "gpt-image-2.5-sunburst");
  assert.equal(body?.quality, "max");
  assert.equal(body?.background, "transparent");
  assert.equal(body?.size, "2880x2880");
  assert.equal(result.details.model, "gpt-image-2.5-sunburst");
  assert.deepEqual(await readFile(result.details.path), PNG);
});

test("Flare reference editing forwards the new options in multipart form", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-imagegen-flare-"));
  const input = join(root, "reference.png");
  await writeFile(input, PNG);
  let form: FormData | undefined;
  const result = await executeImageGen(
    {
      prompt: "preserve the outline",
      image_paths: [input],
      model: "gpt-image-2.5-flare",
      quality: "xhigh",
      background: "opaque",
    },
    root,
    undefined,
    {
      apiKeyResolver: async () => "dummy-key",
      homeDirectory: root,
      fetchFn: (async (url, init) => {
        assert.equal(String(url), `${AZURE_BASE_URL}images/edits`);
        assert.ok(init?.body instanceof FormData);
        form = init.body;
        return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
      }) as typeof fetch,
    },
  );
  assert.equal(form?.get("model"), "gpt-image-2.5-flare");
  assert.equal(form?.get("quality"), "xhigh");
  assert.equal(form?.get("background"), "opaque");
  assert.equal((form?.get("image") as File).name, "reference.png");
  assert.equal(result.details.model, "gpt-image-2.5-flare");
});

async function readUsageLog(root: string) {
  const text = await readFile(join(root, ".pi", "agent", "imagegen-usage.jsonl"), "utf8");
  assert.ok(text.endsWith("\n"));
  return { text, rows: text.trim().split("\n").map((line) => JSON.parse(line)) };
}

test("completed generation and edit append usage without storing prompts or images", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-imagegen-ledger-"));
  const input = join(root, "reference.png");
  await writeFile(input, PNG);
  const first = await executeImageGen(
    {
      prompt: "PROMPT_MUST_NOT_BE_LOGGED",
      model: "gpt-image-2.5-sunburst", quality: "max", size: "2880x2880", background: "opaque",
      output_path: "first.png",
    }, root, undefined,
    {
      homeDirectory: root, apiKeyResolver: async () => "KEY_MUST_NOT_BE_LOGGED",
      fetchFn: (async () => Response.json({
        data: [{ b64_json: PNG.toString("base64"), revised_prompt: "REVISED_PROMPT_MUST_NOT_BE_LOGGED" }],
        usage: {
          input_tokens: 130, output_tokens: 205, total_tokens: 335,
          input_tokens_details: { text_tokens: 30, image_tokens: 100 },
          output_tokens_details: { text_tokens: 5, image_tokens: 200 },
        },
      }, { headers: { "x-request-id": "provider-request-1" } })) as typeof fetch,
    },
  );
  await executeImageGen(
    { prompt: "second", image_paths: [input], output_path: "second.png" }, root, undefined,
    {
      homeDirectory: root, apiKeyResolver: async () => "dummy",
      fetchFn: (async () => Response.json({ data: [{ b64_json: PNG.toString("base64") }] })) as typeof fetch,
    },
  );
  const { text, rows } = await readUsageLog(root);
  assert.equal(rows.length, 2);
  const [a, b] = rows;
  assert.equal(a.model, "gpt-image-2.5-sunburst");
  assert.equal(a.quality, "max");
  assert.equal(a.size, "2880x2880");
  assert.equal(a.background, "opaque");
  assert.equal(a.operation, "generation");
  assert.equal(a.status, "success");
  assert.equal(a.error_stage, null);
  assert.equal(a.http_status, 200);
  assert.equal(a.request_id, "provider-request-1");
  assert.equal(a.output_path, first.details.path);
  assert.ok(Number.isFinite(Date.parse(a.timestamp)));
  assert.ok(a.duration_ms >= 0);
  assert.deepEqual(
    [a.input_tokens, a.output_tokens, a.total_tokens, a.input_text_tokens, a.input_image_tokens, a.output_text_tokens, a.output_image_tokens],
    [130, 205, 335, 30, 100, 5, 200],
  );
  assert.equal(b.operation, "edit");
  assert.equal(b.reference_count, 1);
  assert.equal(b.quality, "low");
  assert.equal(b.input_tokens, null);
  assert.equal(b.output_tokens, null);
  for (const row of rows) {
    assert.equal(row.cost, null);
    assert.equal(row.currency, null);
    assert.equal(row.cost_source, "unknown");
  }
  for (const privateText of ["PROMPT_MUST_NOT_BE_LOGGED", "KEY_MUST_NOT_BE_LOGGED", "REVISED_PROMPT_MUST_NOT_BE_LOGGED", PNG.toString("base64")]) {
    assert.equal(text.includes(privateText), false);
  }
});

test("failed and cancelled API attempts remain in the ledger with unknown costs", async (t) => {
  for (const kind of ["network", "http", "cancelled"] as const) {
    await t.test(kind, async () => {
      const root = await mkdtemp(join(tmpdir(), "azure-imagegen-failed-ledger-"));
      const controller = new AbortController();
      const secret = "ERROR_BODY_MUST_NOT_BE_LOGGED";
      const fetchFn = (async () => {
        if (kind === "http") return Response.json({ error: { message: secret } }, { status: 429 });
        if (kind === "cancelled") controller.abort();
        throw new Error(secret);
      }) as typeof fetch;
      await assert.rejects(executeImageGen(
        { prompt: "fail" }, root, controller.signal,
        { homeDirectory: root, apiKeyResolver: async () => secret, fetchFn },
      ));
      const { text, rows } = await readUsageLog(root);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, kind === "cancelled" ? "cancelled" : "failed");
      assert.equal(rows[0].error_stage, kind === "http" ? "response" : "request");
      assert.equal(rows[0].http_status, kind === "http" ? 429 : null);
      assert.equal(rows[0].input_tokens, null);
      assert.equal(rows[0].output_tokens, null);
      assert.equal(rows[0].cost, null);
      assert.equal(rows[0].output_path, null);
      assert.equal(text.includes(secret), false);
    });
  }
});

test("a local save failure retains the API usage instead of hiding the request", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-imagegen-save-ledger-"));
  const output = join(root, "occupied-during-request.png");
  await assert.rejects(executeImageGen(
    { prompt: "race", output_path: output }, root, undefined,
    {
      homeDirectory: root, apiKeyResolver: async () => "dummy",
      fetchFn: (async () => {
        await writeFile(output, "other writer");
        return Response.json({
          data: [{ b64_json: PNG.toString("base64") }],
          usage: { input_tokens: 25, output_tokens: 150, total_tokens: 175 },
        });
      }) as typeof fetch,
    },
  ), /output already exists/);
  const { rows } = await readUsageLog(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].error_stage, "output");
  assert.equal(rows[0].http_status, 200);
  assert.equal(rows[0].input_tokens, 25);
  assert.equal(rows[0].output_tokens, 150);
  assert.equal(rows[0].cost, null);
  assert.equal(await readFile(output, "utf8"), "other writer");
});

test("a ledger write failure warns without discarding a completed image", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-imagegen-ledger-warning-"));
  await mkdir(join(root, ".pi", "agent", "imagegen-usage.jsonl"), { recursive: true });
  const result = await executeImageGen(
    { prompt: "still return my image", output_path: "result.png" }, root, undefined,
    {
      homeDirectory: root, apiKeyResolver: async () => "dummy",
      fetchFn: (async () => Response.json({ data: [{ b64_json: PNG.toString("base64") }] })) as typeof fetch,
    },
  );
  assert.deepEqual(await readFile(result.details.path), PNG);
  assert.ok(result.content.some((item) => item.type === "text" && /usage log.*could not be written/i.test(item.text)));
});
