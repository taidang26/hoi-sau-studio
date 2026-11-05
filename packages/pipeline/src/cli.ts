#!/usr/bin/env node
/**
 *   npm run pipeline -- run [--mock] [--final] [--force] [--no-publish] [--lead slug] [--direction "…"]
 *       one episode for today, end to end; a finished day is skipped unless --force
 *   npm run pipeline -- schedule [--at 19:00] [--mock]
 *       stay running and make one episode a day at that Hanoi time (catches up if the machine was off)
 *   npm run pipeline -- status [--mock]
 *       the last runs and where each stopped
 *
 * --mock (or PIPELINE_MOCK=1) runs everything offline into data-demo/.
 */

import { buildDeps, loadDotEnv } from "./config.js";
import { runDaily } from "./pipeline.js";
import { loadRuns, type Run } from "./runs.js";
import { hanoiDate, missedToday, nextSlot, parseTime } from "./schedule.js";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const value = (f: string) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const ts = () => new Date().toISOString().slice(11, 19);
const log = (s: string) => console.log(`[${ts()}] ${s}`);

const ICON: Record<string, string> = { done: "✓", warn: "!", skipped: "-", failed: "✗", running: "…" };

function printRun(r: Run) {
  console.log(`${r.id} [${r.mode}] ${r.status}${r.episodeId ? ` · ${r.episodeId}` : ""}${r.error ? ` · ${r.error}` : ""}`);
  for (const s of r.stages) console.log(`  ${ICON[s.status] ?? "?"} ${s.name.padEnd(9)} ${s.note ?? s.error ?? ""}`);
  for (const p of r.posts) console.log(`    ${p.status === "published" ? "✓" : p.status === "skipped" ? "-" : "✗"} ${p.platform} ${p.format} ${p.permalink ?? p.error ?? ""}`);
}

async function main() {
  loadDotEnv();
  const [cmd] = argv;
  const flags = {
    mock: has("mock") || undefined,
    final: has("final"),
    publish: has("no-publish") ? false : undefined,
    lead: value("lead"),
    direction: value("direction"),
    log,
  };

  if (cmd === "run") {
    const run = await runDaily(buildDeps(flags), { force: has("force") });
    printRun(run);
    if (run.status === "failed") process.exitCode = 1;
    return;
  }

  if (cmd === "status") {
    const deps = buildDeps({ ...flags, log: undefined });
    const runs = loadRuns(deps.dataDir).slice(0, Number(value("n") ?? 5));
    if (!runs.length) console.log("No runs yet.");
    runs.forEach(printRun);
    return;
  }

  if (cmd === "schedule") {
    const at = value("at") ?? process.env.PIPELINE_AT ?? "19:00";
    parseTime(at);
    const once = async () => {
      try {
        const run = await runDaily(buildDeps(flags));
        printRun(run);
      } catch (e) {
        log(`run failed to start: ${e instanceof Error ? e.message : e}`);
      }
    };
    const dataDir = buildDeps({ ...flags, log: undefined }).dataDir;
    const ranToday = loadRuns(dataDir).some((r) => r.date === hanoiDate(new Date()) && r.status !== "failed");
    if (missedToday(new Date(), at, ranToday)) {
      log(`Today's ${at} slot was missed; running now.`);
      await once();
    }
    for (;;) {
      const next = nextSlot(new Date(), at);
      log(`Next episode at ${at} Hanoi time (${next.toISOString()}).`);
      // Sleep in short steps so a laptop waking from sleep does not overshoot by hours.
      while (Date.now() < next.getTime()) await new Promise((r) => setTimeout(r, Math.min(60_000, next.getTime() - Date.now())));
      await once();
    }
  }

  console.log(
    'commands: run [--mock] [--final] [--force] [--no-publish] [--lead slug] [--direction "…"] | schedule [--at HH:MM] [--mock] | status [--mock] [--n 5]',
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
