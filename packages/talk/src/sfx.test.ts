import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { availableSfx, sfxDir, sfxFile, sfxMix } from "./sfx.js";

test("only made sounds are offered, and the mix lands the sound at the punchline", () => {
  const root = mkdtempSync(join(tmpdir(), "hoisau-sfx-"));
  assert.deepEqual(availableSfx(root), []);
  mkdirSync(sfxDir(root), { recursive: true });
  writeFileSync(join(sfxDir(root), "ting.wav"), "x");
  assert.deepEqual(availableSfx(root).map((s) => s.name), ["ting"]);
  assert.ok(sfxFile(root, "ting"));
  assert.equal(sfxFile(root, "boing"), undefined);
  assert.equal(sfxFile(root, undefined), undefined);
  assert.match(sfxMix(true, 2.5, 8), /adelay=2500\|2500/);
  assert.match(sfxMix(true, 2.5, 8), /afade=t=out:st=6\.80/);
  assert.doesNotMatch(sfxMix(false, 1, 8), /afade/);
});

test("the library resolves a name to the meme sound, then Envato, Freesound, AudioGen", async () => {
  const { soundLibrary, houseMix } = await import("./sfx.js");
  const root = mkdtempSync(join(tmpdir(), "hoisau-sfxlib-"));
  const dir = sfxDir(root);
  mkdirSync(join(dir, "_lib"), { recursive: true });
  mkdirSync(join(dir, "_meme"), { recursive: true });
  for (const f of ["ting.wav", "dia-xuoc.wav"]) writeFileSync(join(dir, f), "x");
  for (const f of ["ting-fs.mp3", "dia-xuoc-env.wav", "dia-xuoc-fs.mp3", "whoosh-env.wav", "notes.txt"]) writeFileSync(join(dir, "_lib", f), "x");
  for (const f of ["vine-boom.mp3", "dia-xuoc.mp3"]) writeFileSync(join(dir, "_meme", f), "x");
  writeFileSync(join(dir, "_meme", "sources.json"), JSON.stringify([{ file: "vine-boom.mp3", title: "Vine Boom" }]));
  const lib = new Map(soundLibrary(root).map((s) => [s.name, s]));
  assert.deepEqual([...lib.keys()].sort(), ["dia-xuoc", "ting", "vine-boom", "whoosh"]);
  assert.match(lib.get("dia-xuoc")!.file, /_meme/);
  assert.match(lib.get("ting")!.file, /ting-fs\.mp3$/);
  assert.match(lib.get("whoosh")!.file, /whoosh-env/);
  assert.equal(lib.get("vine-boom")!.kind, "meme");
  assert.match(lib.get("vine-boom")!.prompt, /Vine Boom/);

  // Music A cut at the punchline, music B after it, sounds at cut+at with their volume and trim.
  const f = houseMix({ music: true, turn: "switch", musicB: true, cut: 3, end: 9, sounds: [{ at: 0 }, { at: 1.6, volume: 0.8, trim: 3 }, { at: -5 }] });
  assert.match(f, /\[1:a\]loudnorm=I=-21.*afade=t=out:st=2\.95:d=0\.1/);
  assert.match(f, /\[2:a\]loudnorm=I=-22.*adelay=3350\|3350\[mb\]/);
  assert.match(f, /\[3:a\]loudnorm=I=-15.*volume=1\.00.*adelay=2930\|2930\[s0\]/);
  assert.match(f, /\[4:a\]atrim=0:3\.00,afade=t=out:st=2\.70:d=0\.3,loudnorm.*volume=0\.80.*adelay=4530\|4530/);
  assert.match(f, /adelay=0\|0\[s2\]/);
  assert.match(f, /amix=inputs=5:duration=longest:normalize=0,atrim=0:9\.00,alimiter=limit=0\.6,loudnorm=I=-14\.5:TP=-1\.5:LRA=11,aresample=44100\[a\]/);
  const keep = houseMix({ music: true, turn: "keep", musicB: false, cut: 3, end: 9, sounds: [{ at: 0 }] });
  assert.match(keep, /afade=t=out:st=7\.80:d=1\.2/);
  assert.match(keep, /\[2:a\]loudnorm=I=-15/);
});
