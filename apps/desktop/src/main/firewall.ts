import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Windows Defender Firewall, as it applies to this app.
 *
 * ## Why this exists
 *
 * The first time LocalCast listens on `0.0.0.0`, Windows shows a dialog: "Allow LocalCast to
 * communicate on these networks?" It appears once, under the window the user is looking at, and
 * if they close it — or click Cancel, or the dialog is on a monitor that is off — Windows writes
 * a **block** rule for the executable and never asks again. From then on every phone times out,
 * the panel says the address is fine, the log says the listener is up, and nothing anywhere
 * names the cause. It is the single most common reason "it does not connect" on a fresh machine,
 * and the one the app had no way to see.
 *
 * ## What it does
 *
 * Reads the inbound rules that mention this program or carry the product name, and says one of
 * four things: allowed, blocked, no rule yet, or "could not tell" (PowerShell missing, a locked
 * down machine). Read-only, no elevation.
 *
 * Repairing — removing the block rules and adding an allow rule — needs administrator rights,
 * and asks for them through the ordinary UAC prompt, once, only when the user presses the button.
 * That is a deliberate exception to "nothing here needs elevation": the alternative is the user
 * finding `wf.msc` on their own, which nobody does.
 *
 * The allow rule is by **port**, not by program path. A portable build unpacks to a fresh
 * temporary directory on every launch, so a rule tied to today's path would be dead tomorrow;
 * TCP 8420–8429 covers the preferred port and the span `bindPreferring` searches. Private and
 * Domain profiles only — a laptop on café Wi-Fi does not get a listening port opened for it.
 */

export const FIREWALL_RULE_NAME = 'LocalCast (local network)';
const PORT_RANGE = '8420-8429';

export interface FirewallRule {
  name: string;
  enabled: boolean;
  action: 'Allow' | 'Block' | string;
  profile: string;
  program: string | null;
}

export type FirewallVerdict = 'allowed' | 'blocked' | 'no-rule' | 'unavailable';

export interface FirewallState {
  state: FirewallVerdict;
  rules: FirewallRule[];
  /** Why `unavailable`, when it is. */
  detail: string | null;
}

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

function samePath(a: string | null, b: string): boolean {
  return a !== null && a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
}

/**
 * The decision, as a pure function over the rules, so it can be tested against fixtures.
 *
 * A block rule for this program wins over everything: it is what Windows writes when the prompt
 * is dismissed, and it is exactly the thing the user cannot see. Failing that, an allow rule —
 * either for this program (the prompt was accepted) or the port rule this app writes — means
 * allowed. Nothing at all means the prompt has not been answered yet, or was answered for a
 * different copy of the executable.
 */
export function interpretFirewallRules(rules: readonly FirewallRule[], exePath: string): FirewallVerdict {
  const enabled = rules.filter((r) => r.enabled);
  const forUs = enabled.filter((r) => samePath(r.program, exePath) || r.name === FIREWALL_RULE_NAME);
  if (forUs.some((r) => r.action === 'Block')) return 'blocked';
  if (forUs.some((r) => r.action === 'Allow')) return 'allowed';
  // A block rule under the product name but at a different path is an older install. Windows
  // matches on path, so it does not bite this copy — but the prompt will not be shown again
  // while it exists either. Reported as "no rule", so the repair is offered.
  return 'no-rule';
}

function parseRules(stdout: string): FirewallRule[] {
  const text = stdout.trim();
  if (text.length === 0) return [];
  const parsed: unknown = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map(
      (row) =>
        row as { Name?: string; Enabled?: string; Action?: string; Profile?: string; Program?: string | null },
    )
    .filter((row) => typeof row.Name === 'string')
    .map((row) => ({
      name: row.Name as string,
      enabled: String(row.Enabled).toLowerCase() === 'true' || String(row.Enabled) === '1',
      action: row.Action ?? '',
      profile: row.Profile ?? '',
      program: typeof row.Program === 'string' && row.Program.length > 0 ? row.Program : null,
    }));
}

/** A PowerShell single-quoted literal. */
function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const INSPECT_SCRIPT = (exePath: string): string =>
  [
    `$exe = ${q(exePath)}`,
    `$named = @(Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'LocalCast*' })`,
    `$byProgram = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -and ($_.Program -ieq $exe) } | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' })`,
    `$all = @($named + $byProgram) | Sort-Object -Property Name -Unique`,
    `$out = @($all | ForEach-Object { $p = ($_ | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue).Program; [pscustomobject]@{ Name = $_.DisplayName; Enabled = [string]$_.Enabled; Action = [string]$_.Action; Profile = [string]$_.Profile; Program = $p } })`,
    `$out | ConvertTo-Json -Compress`,
  ].join('; ');

export async function inspectFirewall(exePath: string, exec: ExecFn = defaultExec): Promise<FirewallState> {
  if (process.platform !== 'win32') return { state: 'unavailable', rules: [], detail: 'not Windows' };
  try {
    const { stdout } = await exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      INSPECT_SCRIPT(exePath),
    ]);
    const rules = parseRules(stdout);
    return { state: interpretFirewallRules(rules, exePath), rules, detail: null };
  } catch (err) {
    return { state: 'unavailable', rules: [], detail: err instanceof Error ? err.message : String(err) };
  }
}

const REPAIR_SCRIPT = (exePath: string): string =>
  [
    `$ErrorActionPreference = 'Continue'`,
    `$exe = ${q(exePath)}`,
    // Block rules for this program, and block rules under the product name from any older copy.
    `Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -and ($_.Program -ieq $exe) } | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Action -eq 'Block' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue`,
    `Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'LocalCast*' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue`,
    `if (-not (Get-NetFirewallRule -DisplayName ${q(FIREWALL_RULE_NAME)} -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName ${q(FIREWALL_RULE_NAME)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT_RANGE} -Profile Private,Domain | Out-Null }`,
  ].join('\r\n');

/**
 * Remove the block and add the allow, with one UAC prompt.
 *
 * The script goes through a file rather than `-Command`, because it has to cross two layers of
 * quoting (ours, then `Start-Process -ArgumentList`) and a rule name with parentheses in it is
 * exactly the kind of thing that does not survive that. `-Wait` so the state read afterwards is
 * the state the script left, not the one it found.
 */
export async function allowThroughFirewall(exePath: string, exec: ExecFn = defaultExec): Promise<FirewallState> {
  if (process.platform !== 'win32') return { state: 'unavailable', rules: [], detail: 'not Windows' };
  const dir = mkdtempSync(join(tmpdir(), 'localcast-firewall-'));
  const script = join(dir, 'allow.ps1');
  writeFileSync(script, REPAIR_SCRIPT(exePath), 'utf8');
  try {
    await exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${q(script)})`,
    ]);
  } catch (err) {
    // The user said no to the UAC prompt, most likely. The state read below is still honest.
    const detail = err instanceof Error ? err.message : String(err);
    const after = await inspectFirewall(exePath, exec);
    rmSync(dir, { recursive: true, force: true });
    return after.state === 'allowed' ? after : { ...after, detail: after.detail ?? detail };
  }
  rmSync(dir, { recursive: true, force: true });
  return inspectFirewall(exePath, exec);
}
