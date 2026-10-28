/**
 * Character creation: one line of idea in, a complete character bible out
 * (look, signature features, palette, expressions, personality, voice,
 * never-says), validated and written as characters/<slug>/profile.yaml.
 * The look stays in English because it feeds Muse Image prompts.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { SeriesBible } from "./bible.js";
import { type ChatMessage, type MuseSpark, S } from "./muse-spark.js";
import { CHARACTERS_DIR, type Profile, validateProfile } from "./profile.js";

export const characterSchema = S.obj({
  name: S.str("Vietnamese display name, 1–3 words, e.g. 'Cu Li'"),
  species: S.str("animal or creature, English then Vietnamese in brackets"),
  office_type: S.str("Vietnamese, the office archetype in a few words"),
  core_gag: S.str("Vietnamese, the one running joke"),
  role: S.str("Vietnamese, job title and a funny twist"),
  want: S.str("Vietnamese, one concrete thing they want at work"),
  fear: S.str("Vietnamese, one concrete, funny thing they dread"),
  contradiction: S.str("Vietnamese, the trait that fights their main trait"),
  edge: S.str("Vietnamese, a rebellious or weird secret side behind the everyday behaviour, big enough to drive a twist and draw in an exaggerated way"),
  life: S.arr(S.str("Vietnamese, a specific everyday detail outside the joke: age, home, family, habit"), 3, 5),
  comic_engine: S.arr(S.str("Vietnamese, a repeatable situation that is funny because of the animal's body or nature, readable without words"), 2, 4),
  relationships: S.arr(S.obj({ with: S.str("existing cast slug"), dynamic: S.str("Vietnamese, a conflict that can repeat") }), 0, 4),
  look: S.obj({
    description: S.str("English, 3–5 sentences: body shape, colours, face, outfit, one prop. Simple shapes that survive a flat comic style."),
    signature: S.arr(S.str("English, one visual feature that must never change"), 3, 5),
    palette: S.arr(S.obj({ name: S.str(), hex: S.str("#RRGGBB") }), 3, 6),
    props: S.arr(S.str("English"), 1, 4),
    expressions: S.arr(S.obj({ name: S.str("default | stressed | happy | or the gag pose"), look: S.str("English") }), 3, 5),
  }),
  personality: S.arr(S.str("Vietnamese"), 4, 6),
  voice: S.obj({
    register: S.str("Vietnamese"),
    speech_pattern: S.str("Vietnamese"),
    catchphrases: S.arr(S.str("Vietnamese, short"), 2, 4),
    sample_lines: S.arr(S.str("Vietnamese"), 2, 4),
  }),
  never_says: S.arr(S.str("Vietnamese"), 4, 7),
});

export interface CharacterDraft {
  name: string;
  species: string;
  office_type: string;
  core_gag: string;
  role: string;
  want: string;
  fear: string;
  contradiction: string;
  edge: string;
  life: string[];
  comic_engine: string[];
  relationships: Array<{ with: string; dynamic: string }>;
  look: {
    description: string;
    signature: string[];
    palette: Array<{ name: string; hex: string }>;
    props: string[];
    expressions: Array<{ name: string; look: string }>;
  };
  personality: string[];
  voice: Profile["voice"];
  never_says: string[];
}

/** "Cá Nóc" → "ca-noc". */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Added to every new character unless the draft already covers the topic. */
const SAFETY: Array<[RegExp, string]> = [
  [/chửi|tục/i, "Chửi thề cảm thán thì che bằng dấu * (đ*m, v*l); không nói tục, không chửi xúc phạm người khác"],
  [/ngoại hình|vùng miền|giới tính/i, "Không chê ngoại hình, vùng miền, giới tính của bất kỳ ai"],
  [/nhãn hàng|người thật/i, "Không nhắc tên công ty, nhãn hàng, người thật"],
  [/chính trị|tôn giáo/i, "Không nói chuyện chính trị, tôn giáo"],
];

export function characterMessages(idea: string, bible?: SeriesBible, existing: string[] = []): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are the lead character designer of a daily Vietnamese office-comedy comic drawn by an image model. Readers are office workers aged 22–32.",
        [
          "Write a character people would recognise as a coworker, not a single office stereotype:",
          "- a concrete want, a concrete fear, and a contradiction that fights their main trait;",
          "- an edge: a rebellious or weird secret side behind the good behaviour, saved for the twist and drawn big;",
          "- 3–5 specific details of their life outside the joke (age, home, family, a habit);",
          "- comedy that comes from situations and the animal's body, readable from the picture alone, and that can repeat for 30 episodes without going stale;",
          "- relationships with the existing cast that create conflict on their own;",
          "- a voice you could recognise without a name tag, with do and don't lists.",
          "Avoid worn-out office memes (final_v2, 'deadline là để tham khảo', 'để anh check lại') unless you give them a new turn.",
          "Name: short, warm, easy to say in both Vietnamese and English, no diacritics, different in sound from the existing cast, with a light link to the animal (e.g. Lolo for a loris). Dialogue rarely uses names, so the name matters less than the silhouette.",
        ].join("\n"),
        "Draw-ability: few details, bold shapes, a distinctive silhouette and 3–6 flat colours, the same every time.",
        "Vietnamese fields are for writers; English fields go into image prompts. Characters may tease each other and have flaws; never base one on a real person or brand.",
        bible ? `Series bible:\n${JSON.stringify({ premise: bible.premise, tone: bible.tone, world: bible.world, rules: bible.rules })}` : "",
        existing.length ? `Existing cast (make the new one clearly different in shape, colour and personality, and give it a relationship with each): ${existing.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    { role: "user", content: `Character idea: ${idea}` },
  ];
}

export function draftToProfile(d: CharacterDraft, slug = slugify(d.name)): Profile {
  const never = [...d.never_says];
  for (const [topic, rule] of SAFETY) if (!never.some((n) => topic.test(n))) never.push(rule);
  return validateProfile(
    {
      slug,
      name: d.name,
      species: d.species,
      status: "candidate",
      office_type: d.office_type,
      core_gag: d.core_gag,
      role: d.role,
      want: d.want,
      fear: d.fear,
      contradiction: d.contradiction,
      edge: d.edge,
      life: d.life,
      comic_engine: d.comic_engine,
      relationships: d.relationships,
      look: {
        style: "flat 2D comic, thick black outline, flat colors, minimal shading, simple shapes",
        description: d.look.description,
        signature: d.look.signature,
        palette: d.look.palette.map((p) => ({ name: p.name, hex: p.hex.toUpperCase() })),
        props: d.look.props,
        expressions: Object.fromEntries(d.look.expressions.map((e) => [e.name, e.look])),
        character_sheet: null,
      },
      personality: d.personality,
      voice: d.voice,
      never_says: never,
      memory: { episodes: [] },
    },
    slug,
  );
}

export async function createCharacter(spark: MuseSpark, idea: string, opts: { bible?: SeriesBible; existing?: Profile[] } = {}): Promise<Profile> {
  const cast = (opts.existing ?? []).map((p) =>
    JSON.stringify({ slug: p.slug, name: p.name, species: p.species, role: p.role, core_gag: p.core_gag, want: p.want, contradiction: p.contradiction, palette: p.look.palette.map((s) => s.hex) }),
  );
  const draft = await spark.json<CharacterDraft>("character", characterSchema, characterMessages(idea, opts.bible, cast));
  // The model fills `expressions` freely; make sure the keys the prompts rely on exist.
  if (!draft.look.expressions.some((e) => e.name === "default")) draft.look.expressions.unshift({ name: "default", look: draft.look.expressions[0]?.look ?? "neutral" });
  return draftToProfile(draft);
}

export function writeProfile(p: Profile, dir = CHARACTERS_DIR, overwrite = false): string {
  const folder = join(dir, p.slug);
  const file = join(folder, "profile.yaml");
  if (existsSync(file) && !overwrite) throw new Error(`characters/${p.slug} already exists`);
  mkdirSync(folder, { recursive: true });
  const header = "# Created with `studio character new`. Edit freely: every Studio step reads this file.\n# Fields under `look` are English because they go into Muse Image prompts.\n";
  writeFileSync(file, header + stringify(p, { lineWidth: 0 }));
  return file;
}
