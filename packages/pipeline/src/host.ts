/**
 * Meta fetches every image and video itself, so each file needs a public
 * HTTPS URL before publishing.
 *
 * StaticDirHost copies files into a folder that something already serves on
 * HTTPS (a web server, a bucket synced from disk, a tunnel to the dashboard)
 * and returns MEDIA_BASE_URL/<episode>/<file>. MockHost only makes up URLs.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

export interface MediaHost {
  /** Makes `file` public as `<episodeId>/<name>` and returns its URL. */
  put(file: string, episodeId: string, name?: string): Promise<string>;
}

export class StaticDirHost implements MediaHost {
  constructor(
    private readonly dir: string,
    private readonly baseUrl: string,
  ) {
    if (!/^https:\/\//.test(baseUrl)) throw new Error("MEDIA_BASE_URL must be an https:// URL that Meta can reach.");
  }

  async put(file: string, episodeId: string, name = basename(file)): Promise<string> {
    mkdirSync(join(this.dir, episodeId), { recursive: true });
    copyFileSync(file, join(this.dir, episodeId, name));
    return `${this.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(episodeId)}/${encodeURIComponent(name)}`;
  }
}

export class MockHost implements MediaHost {
  readonly files: string[] = [];
  async put(file: string, episodeId: string, name = basename(file)): Promise<string> {
    this.files.push(file);
    return `https://media.hoisau.example/${episodeId}/${name}`;
  }
}

export function hostFromEnv(env: NodeJS.ProcessEnv): MediaHost | undefined {
  if (env.MEDIA_DIR && env.MEDIA_BASE_URL) return new StaticDirHost(env.MEDIA_DIR, env.MEDIA_BASE_URL);
  return undefined;
}
