#!/usr/bin/env node
/**
 * Studio CLI.
 *
 *   npm run studio -- characters                 validate and list character profiles
 *   npm run studio -- brand-art [brand…] [--only avatar|cover] [--recrop] [--mock] profile pictures and cover photos for the pages in channels.yaml
 *   npm run studio -- edge [slug…] [--mock]      one picture of each character's rebellious or weird side
 *   npm run studio -- office                     draw the office floor plan to series/office-plan.png
 *   npm run studio -- style [--mock]             draw the test scene in every series style variant
 *   npm run studio -- style approve <variant>    lock that render as the series style reference
 *   npm run studio -- sheet <slug|all> [--mock]  Muse Image consistency test
 *   npm run studio -- sheet approve <slug>       lock that sheet as the model sheet
 *   npm run studio -- character new "<idea>" [--mock]
 *   npm run studio -- episode headline <id> "…"   (quote band above a single panel)
 *   npm run studio -- episode new <id> --lead <slug> [--with a,b] [--format strip3|single] [--headline "câu trích"] --direction "…" [--credit "name: comment"]
 *   npm run studio -- episode new <id> --lead <slug> [--with a,b] --from-listen data/listen/<id>.json
 *   npm run studio -- episode run <id> [--from step] [--to step] [--finish [--no-recolour]] [--mock]
 *                    --finish: before lettering, Muse Image recolours each panel (soft shading, one muted tone), then
 *                    SAM 3.1 keeps the panel's main characters sharp and softens the rest (finish.ts)
 *   npm run studio -- episode approve <id> [--post post.json] [--despite-warnings]
 *       the owner's sign-off; `channel publish` refuses anything not approved as it is
 *   npm run studio -- episode list
 *   npm run studio -- video approve <id> <video.mp4|still.jpg> --post post.json
 *       the same sign-off for a finished video (reels-9x16) or still (image-4x5) made outside the episode steps
 *   npm run studio -- tai                        the owner's phone page (site/public/tai) from every approved video and photo post
 *
 * Reads META_API_KEY (or MODEL_API_KEY) from the environment or .env.
 * Output goes to output/characters/<slug>/ and output/style/.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ListenReport } from "@hoi-sau/story";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runConsistency } from "./consistency.js";
import { mockTransport } from "./mock.js";
import { MUSE_IMAGE_MODEL, MuseImage } from "./muse-image.js";
import { listCharacters, loadProfile } from "./profile.js";
import { createCharacter, writeProfile } from "./create.js";
import { approveEpisode, approveVideo, checkForApproval } from "./approve.js";
import { whoAmI } from "./provenance.js";
import { createEpisode, doneSteps, setHeadline, episodeDir, EPISODES_DIR, EPISODE_FORMATS, EPISODE_STEPS, type EpisodeFormat, type EpisodeStep, listEpisodes, readStep, runEpisode } from "./episode.js";
import { approveSheet, openStudio } from "./studio.js";
import { approveStyle, loadStyle, runStyleTest, styleReference, styleText } from "./style.js";
import { loadOffice, officePlanSvg } from "./office.js";
import { loadBrandList, makeBrandArt } from "./brand-art.js";
import { makeEdgeArt } from "./edge-art.js";
import { SERIES_DIR } from "./bible.js";
import { buildTai } from "./tai.js";
import { ALL_FONT_PATHS, svgToPng } from "@hoi-sau/svg-text";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function loadDotEnv(): void {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const unCaret = (s: string): string => s.replace(/\^(?=\s)/g, "").replace(/^\^|\^$/g, "");

async function main(argv: string[]): Promise<void> {
  loadDotEnv();
  // npm.cmd on Windows passes quoted text through cmd.exe, which can leave its escape caret before each space.
  const [cmd, ...rest] = process.platform === "win32" ? argv.map(unCaret) : argv;
  // --flag value pairs; a flag followed by another flag (or nothing) is boolean.
  const opts: Record<string, string[]> = {};
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) args.push(a);
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") && a !== "--mock") (opts[a] ??= []).push(rest[++i]);
    else (opts[a] ??= []).push("");
  }
  const flags = new Set(Object.keys(opts));
  const opt = (k: string) => opts[k]?.[0];
  const mock = flags.has("--mock") || process.env.MUSE_MOCK === "1";

  if (cmd === "characters") {
    for (const slug of listCharacters()) {
      const p = loadProfile(slug);
      console.log(`${p.slug.padEnd(8)} ${p.name.padEnd(8)} ${p.status.padEnd(10)} ${p.office_type}`);
    }
    return;
  }

  const imageClient = () => (mock ? new MuseImage({ apiKey: "mock", transport: mockTransport().transport }) : MuseImage.fromEnv());

  if (cmd === "brand-art") {
    const ctx = openStudio({ mock, log: console.log });
    const all = loadBrandList();
    const brands = args.length ? all.filter((b) => args.includes(b.id)) : all;
    if (!brands.length) throw new Error(`no such brand; known: ${all.map((b) => b.id).join(", ")}`);
    const out = join(ROOT, "output", "brand-art");
    const only = opt("--only") as "avatar" | "cover" | undefined;
    if (only && only !== "avatar" && only !== "cover") throw new Error("--only takes avatar or cover");
    const { art } = await makeBrandArt(ctx, brands, out, console.log, { only, recrop: flags.has("--recrop") });
    console.log(`${art.length} brands → ${out} (avatar.png, cover.png, cover-title.png each)`);
    return;
  }

  if (cmd === "edge") {
    const ctx = openStudio({ mock, log: console.log });
    const slugs = args.length ? args : listCharacters();
    const out = join(ROOT, "output", "edge");
    const { files } = await makeEdgeArt(ctx, slugs, out, console.log);
    console.log(`${files.length} pictures → ${join(out, "index.html")}`);
    return;
  }

  if (cmd === "office") {
    const office = loadOffice();
    if (!office) throw new Error("no series/office.yaml");
    const profiles = listCharacters().map((slug) => loadProfile(slug));
    const svg = officePlanSvg(
      office,
      Object.fromEntries(profiles.map((p) => [p.slug, p.name])),
      Object.fromEntries(profiles.map((p) => [p.slug, p.look.palette[0]?.hex ?? "#ffd77a"])),
    );
    const out = join(SERIES_DIR, "office-plan.png");
    writeFileSync(out, svgToPng(svg, { fontFiles: ALL_FONT_PATHS }));
    console.log(`floor plan → ${out}`);
    return;
  }

  if (cmd === "style" && args[0] === "approve") {
    const id = args[1];
    if (!id) throw new Error("usage: style approve <variant>");
    const name = approveStyle(id, join(ROOT, "output", "style"));
    console.log(`series style: ${id}, locked series/${name}. Next: npm run studio -- sheet all`);
    return;
  }

  if (cmd === "style") {
    const style = loadStyle();
    if (!style) throw new Error("no series/style.yaml");
    const out = join(ROOT, "output", "style");
    const renders = await runStyleTest(imageClient(), style, out, { mock, log: console.log });
    console.log(`${renders.length} variants → ${join(out, "review.html")}. Then: npm run studio -- style approve <${style.variants.map((v) => v.id).join("|")}>`);
    return;
  }

  if (cmd === "sheet" && args[0] === "approve") {
    const slug = args[1];
    if (!slug) throw new Error("usage: sheet approve <slug>");
    const name = approveSheet(slug, join(ROOT, "output", "characters", slug));
    console.log(`${slug}: locked characters/${slug}/${name} as the model sheet`);
    return;
  }

  if (cmd === "character" && args[0] === "new") {
    const idea = args.slice(1).join(" ");
    if (!idea) throw new Error('usage: character new "<idea>" [--mock]');
    const ctx = openStudio({ mock });
    const profile = await createCharacter(ctx.spark, idea, { bible: ctx.bible, existing: [...ctx.profiles.values()] });
    const file = writeProfile(profile);
    console.log(`${profile.slug}: ${profile.name}, ${profile.species} → ${file}`);
    console.log(`next: npm run studio -- sheet ${profile.slug}, then sheet approve ${profile.slug}`);
    return;
  }

  if (cmd === "episode" && args[0] === "list") {
    for (const id of listEpisodes()) console.log(`${id.padEnd(16)} ${doneSteps(id).join(" → ") || "(new)"}`);
    return;
  }

  if (cmd === "episode" && args[0] === "headline") {
    const [, id, ...words] = args;
    if (!id) throw new Error('usage: episode headline <id> "câu trên đầu tranh" (empty clears it)');
    const ep = setHeadline(id, words.join(" "));
    console.log(ep.headline ? `${id}: headline set. Run: episode run ${id} --from safety` : `${id}: headline cleared`);
    return;
  }
  if (cmd === "episode" && args[0] === "new") {
    const id = args[1];
    const lead = opt("--lead");
    // A `story listen` report carries the direction, the credit and the cameo.
    const listenFile = opt("--from-listen");
    const report = listenFile ? (JSON.parse(readFileSync(listenFile, "utf8")) as ListenReport) : undefined;
    const direction = opt("--direction") ?? report?.pick.spec.direction;
    const format = opt("--format") as EpisodeFormat | undefined;
    if (format && !EPISODE_FORMATS.includes(format)) throw new Error(`--format must be one of ${EPISODE_FORMATS.join(", ")}`);
    if (!id || !lead || !direction)
      throw new Error('usage: episode new <id> --lead <slug> [--with a,b] (--direction "…" [--credit "name: comment"] | --from-listen <file>)');
    const ep = createEpisode({
      id,
      lead,
      characters: (opt("--with") ?? "").split(",").filter(Boolean),
      direction,
      ...(format ? { format } : {}),
      ...(opt("--headline") ? { headline: opt("--headline") } : {}),
      credits: opts["--credit"]
        ? opts["--credit"].map((c) => {
            const [name, ...comment] = c.split(":");
            return { name: name.trim(), comment: comment.join(":").trim() };
          })
        : (report?.pick.spec.credits ?? []),
      source: report
        ? { kind: opt("--direction") ? "manual" : report.pick.source, by: whoAmI(), commentIds: report.pick.commentIds, report: listenFile }
        : { kind: "manual", by: whoAmI() },
    });
    if (report) writeFileSync(join(episodeDir(id), "listen.json"), JSON.stringify(report.pick, null, 2) + "\n");
    console.log(`${ep.id}: ${ep.characters.join(", ")}. next: npm run studio -- episode run ${ep.id}`);
    return;
  }

  if (cmd === "episode" && args[0] === "approve") {
    const id = args[1];
    if (!id) throw new Error("usage: episode approve <id> [--post post.json] [--despite-warnings]");
    const { warnings } = checkForApproval(id);
    for (const w of warnings) console.log(`warning: ${w.text}`);
    const a = approveEpisode(id, { postFile: opt("--post"), despiteWarnings: flags.has("--despite-warnings") });
    console.log(`${id} approved by ${a.approvedBy}: ${Object.keys(a.files).length} files${a.post ? " and the post" : "; no post file yet, approve again once it exists"}.`);
    return;
  }

  if (cmd === "tai") {
    const { file, items, skipped } = buildTai({ episodes: EPISODES_DIR, posts: join(ROOT, "data", "posts"), site: join(ROOT, "site", "public") });
    for (const s of skipped) console.log(`left out ${s}`);
    console.log(`${file}: ${items.length} posts. Deploy with: npm run site -- deploy`);
    return;
  }

  if (cmd === "video" && args[0] === "approve") {
    const [, id, video] = args;
    const postFile = opt("--post");
    if (!id || !video || !postFile) throw new Error("usage: video approve <id> <video.mp4> --post post.json");
    const a = approveVideo(id, video, postFile);
    console.log(`${id} approved by ${a.approvedBy}: ${Object.keys(a.files)[0]} and the post. Publish with: npm run channel -- publish ${postFile}`);
    return;
  }

  if (cmd === "episode" && args[0] === "run") {
    const id = args[1];
    if (!id) throw new Error("usage: episode run <id> [--from step] [--to step] [--finish] [--mock]");
    const step = (k: string) => {
      const v = opt(k);
      if (v && !EPISODE_STEPS.includes(v as EpisodeStep)) throw new Error(`${k} must be one of ${EPISODE_STEPS.join(", ")}`);
      return v as EpisodeStep | undefined;
    };
    const ctx = openStudio({ mock, log: console.log });
    if (flags.has("--finish") && !mock) {
      // SAM 3.1 lives in @hoi-sau/dance, which depends on this package, so it is loaded at run time.
      const dance = "@hoi-sau/dance";
      const { Sam } = (await import(dance).catch(() => {
        throw new Error("--finish needs SAM 3.1 from @hoi-sau/dance (npm install at the repo root)");
      })) as { Sam: { fromEnv(): import("./finish.js").Segmenter } };
      ctx.segmenter = Sam.fromEnv();
      ctx.recolour = !flags.has("--no-recolour");
    }
    const ran = await runEpisode(ctx, id, { from: step("--from"), to: step("--to") });
    const letter = readStep<{ pages: Array<{ file: string }>; page?: string }>(id, "letter");
    console.log(ran.length ? `${id}: ran ${ran.join(" → ")}` : `${id}: every step is done; use --from to rerun`);
    if (letter) console.log(`pages: ${[letter.page, ...letter.pages.map((p) => p.file)].filter(Boolean).join(", ")} in episodes/${id}/`);
    return;
  }

  if (cmd === "sheet") {
    const target = args[0];
    if (!target) throw new Error("usage: sheet <slug|all> [--mock]");
    const slugs = target === "all" ? listCharacters() : [target];
    const client = imageClient();
    const model = mock ? "mock" : process.env.MUSE_IMAGE_MODEL || MUSE_IMAGE_MODEL;
    const style = loadStyle();
    if (style && !style.chosen) console.log("no series style chosen yet: run `studio style`, then `style approve <variant>` (using the base style for now)");
    for (const slug of slugs) {
      const profile = loadProfile(slug);
      const out = join(ROOT, "output", "characters", slug);
      const run = await runConsistency(client, profile, out, { model, mock, log: console.log, style: style && styleText(style), styleRef: styleReference(style) });
      const tokens = run.images.reduce((n, i) => n + (i.usage.total_tokens ?? 0), 0);
      console.log(`${slug}: ${run.images.length} images, ${tokens} tokens → ${join(out, "review.html")}`);
    }
    return;
  }

  console.log("commands: characters | style | style approve <variant> | sheet <slug|all> | sheet approve <slug> | character new <idea> | episode new|run|approve|list   (add --mock to run offline)");
  process.exitCode = cmd ? 1 : 0;
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
