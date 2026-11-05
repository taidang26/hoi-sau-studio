/**
 * Backups of what lives only on this machine: comments, inbox, publish journal,
 * research images (data/), drawn episodes (episodes/), story memory and the
 * character folders with their sheets. Git already keeps the rest.
 *
 * Each backup is a dated folder of plain copies, so it opens without any tool.
 * The last few are kept. Secrets (.env) are never copied: a backup folder is
 * often a synced cloud folder, and the keys can be pasted again in Settings.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { t } from "./i18n.js";

export interface BackupOptions {
  /** Folders and files to copy, each kept under its own name. */
  sources: string[];
  /** Where backups go; read on every run so a change in Settings applies at once. */
  dir: () => string;
  /** How many backups to keep (3: each is a full copy). */
  keep?: number;
  /** No backup when the drive has less free than this (GB). */
  minFreeGb?: number;
  /** For tests: free bytes where backups go. */
  freeBytes?: (dir: string) => number | undefined;
  /** Hours between automatic backups. */
  everyHours?: number;
  now?: () => Date;
}

export interface BackupInfo {
  dir: string;
  last?: { at: Date; name: string };
  count: number;
  running: boolean;
  error?: string;
}

/**
 * What a backup leaves out: secrets, and what the videos can make again, which grew one backup to
 * 2.75 GB and filled the drive (renders, sound, the raw and retry pictures of a fix, undo copies,
 * frames). The shots, plans and meta of each video are kept.
 */
export function backupSkips(f: string): boolean {
  const name = basename(f), parts = f.split(/[\\/]/);
  if (name === ".env" || parts.includes("node_modules")) return true;
  const inVideo = parts.includes("video") || parts.includes("talk");
  if (!inVideo) return false;
  if (parts.includes("undo") || parts.includes("frames")) return true;
  return /\.(mp4|m4a|wav|mov|webm)$/i.test(name) || /\.raw\.png$|-fix\d+\.(raw|pasted)\.png$|-prev\.png$/i.test(name);
}

/** Free space where backups go, in bytes; undefined when it cannot be read. */
function freeBytes(dir: string): number | undefined {
  try {
    const st = statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return undefined;
  }
}

const STAMP = /^\d{4}-\d{2}-\d{2}_\d{4}$/;
const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

export class Backup {
  private running = false;
  private error?: string;
  private timer?: NodeJS.Timeout;

  constructor(readonly opts: BackupOptions) {}

  private list(): string[] {
    const dir = this.opts.dir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => STAMP.test(n) && existsSync(join(dir, n, "done")))
      .sort();
  }

  info(): BackupInfo {
    const names = this.list();
    const name = names[names.length - 1];
    return {
      dir: this.opts.dir(),
      last: name ? { name, at: statSync(join(this.opts.dir(), name, "done")).mtime } : undefined,
      count: names.length,
      running: this.running,
      error: this.error,
    };
  }

  /** Copies everything now and drops the oldest copies. Returns the new folder's name. */
  run(): string {
    if (this.running) throw new Error(t("Đang sao lưu, đợi xong đã."));
    this.running = true;
    let dest = "";
    try {
      const dir = this.opts.dir();
      const name = stamp((this.opts.now ?? (() => new Date()))());
      dest = join(dir, name);
      mkdirSync(dir, { recursive: true });
      // A backup must never be what fills the drive (the dashboard and the posting schedule need room).
      const free = (this.opts.freeBytes ?? freeBytes)(dir);
      const min = (this.opts.minFreeGb ?? 5) * 1024 ** 3;
      if (free !== undefined && free < min) throw new Error(t("Ổ đĩa còn {gb} GB, chưa sao lưu để không làm đầy ổ. Xoá bớt bản sao lưu cũ hoặc đổi nơi lưu.", { gb: (free / 1024 ** 3).toFixed(1) }));
      mkdirSync(dest, { recursive: true });
      for (const src of this.opts.sources) {
        if (!existsSync(src)) continue;
        cpSync(src, join(dest, basename(src)), { recursive: true, filter: (f) => !backupSkips(f) });
      }
      // Written last: a folder without it was cut short and is not counted.
      writeFileSync(join(dest, "done"), new Date().toISOString());
      const keep = this.opts.keep ?? 3;
      const names = this.list();
      for (const old of names.slice(0, Math.max(0, names.length - keep))) rmSync(join(dir, old), { recursive: true, force: true });
      this.error = undefined;
      return name;
    } catch (e) {
      // A copy cut short (a full drive) is taken away, not left to hold the space.
      if (dest && !existsSync(join(dest, "done"))) rmSync(dest, { recursive: true, force: true });
      this.error = (e as Error).message;
      throw e;
    } finally {
      this.running = false;
    }
  }

  /** Backs up now if the last one is older than the interval, then on that interval. */
  schedule(log: (line: string) => void = () => {}): void {
    const every = (this.opts.everyHours ?? 6) * 3600_000;
    const tick = () => {
      const last = this.info().last?.at.getTime() ?? 0;
      if (Date.now() - last < every) return;
      try {
        log(t("Đã sao lưu: {name}", { name: this.run() }));
      } catch (e) {
        log(t("Sao lưu lỗi: {e}", { e: (e as Error).message }));
      }
    };
    setTimeout(tick, 5_000).unref();
    this.timer = setInterval(tick, 15 * 60_000);
    this.timer.unref();
  }
}
