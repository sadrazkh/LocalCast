import { execFile } from 'node:child_process';

/**
 * The other copies of LocalCast on this machine.
 *
 * Needed for exactly one thing: when a newer build starts while an older one is still sitting in
 * the tray, and the older one does not know how to step aside. See `singleInstance.ts`.
 */

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  path: string | null;
}

export type ExecFn = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/**
 * Every process whose image name starts with `LocalCast`.
 *
 * That covers the installed `LocalCast.exe`, the portable `LocalCast-Portable-<version>.exe`
 * launcher, and the `LocalCast.exe` it unpacks and runs — plus every renderer and GPU child of
 * each, which Electron names after the parent. CIM rather than `tasklist`, because `tasklist`
 * does not report the parent PID and the parent is what tells ours from theirs.
 */
export async function listLocalCastProcesses(exec: ExecFn = defaultExec): Promise<ProcessInfo[]> {
  if (process.platform !== 'win32') return [];
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name LIKE 'LocalCast%'\" | " +
    'Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress';
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const text = stdout.trim();
  if (text.length === 0) return [];

  // `ConvertTo-Json` emits a bare object for a single result and an array for several.
  const parsed: unknown = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => row as { ProcessId?: number; ParentProcessId?: number; Name?: string; ExecutablePath?: string | null })
    .filter((row) => typeof row.ProcessId === 'number')
    .map((row) => ({
      pid: row.ProcessId as number,
      ppid: typeof row.ParentProcessId === 'number' ? row.ParentProcessId : 0,
      name: row.Name ?? '',
      path: row.ExecutablePath ?? null,
    }));
}

/**
 * The processes that are *not* us.
 *
 * "Us" is this process, its parent — in a portable build the parent is the self-extracting
 * launcher, and killing it would kill the build the user just double-clicked — and everything
 * descended from this process, which is Electron's own renderer and GPU children. What remains is
 * the other instance's tree, ordered so that each parent comes before its children: killing a
 * parent first is what stops Electron respawning a helper we have just killed.
 */
export function foreignInstances(
  all: readonly ProcessInfo[],
  self: { pid: number; ppid: number },
): ProcessInfo[] {
  const ours = new Set<number>([self.pid, self.ppid]);
  // Descendants of this process, to any depth. A few passes over a list this short is fine.
  let grew = true;
  while (grew) {
    grew = false;
    for (const proc of all) {
      if (!ours.has(proc.pid) && ours.has(proc.ppid)) {
        ours.add(proc.pid);
        grew = true;
      }
    }
  }

  const foreign = all.filter((proc) => !ours.has(proc.pid));
  const foreignPids = new Set(foreign.map((proc) => proc.pid));
  // Roots — processes whose parent is not itself a foreign LocalCast process — first.
  return [...foreign].sort((a, b) => {
    const aRoot = foreignPids.has(a.ppid) ? 1 : 0;
    const bRoot = foreignPids.has(b.ppid) ? 1 : 0;
    return aRoot - bRoot || a.pid - b.pid;
  });
}

/** Terminate one process. False when the OS refused — which it will if it belongs to another user. */
export async function killProcess(pid: number, exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
    return true;
  } catch {
    return false;
  }
}
