import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const run = promisify(execFile);

// Inspect security descriptors only, never credential contents. Windows mode/uid
// are not POSIX permissions. Keep access limited to this user, SYSTEM and admins.
export async function assertPrivateWindowsAcl(paths: string[]): Promise<void> {
  const encodedPaths = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$paths = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPaths}')))
$sidType = [Security.Principal.SecurityIdentifier]
$allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($path in $paths) {
  $acl = Get-Acl -LiteralPath $path
  if ($allowed -notcontains $acl.GetOwner($sidType).Value) { throw 'unsafe owner' }
  $rules = $acl.GetAccessRules($true, $true, $sidType)
  if ($rules.Count -eq 0) { throw 'missing access rules' }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $allowed -notcontains $rule.IdentityReference.Value) { throw 'broad access' }
  }
}
[Console]::Write('ok')
`;
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await run(powershell, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], { timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true });
  if (stdout.trim() !== "ok") throw new Error("Windows credential ACL is invalid");
}
