/**
 * The rest drawing a puppet is cut from: Muse Image draws the character
 * front-on in an A-pose, on-model from its locked sheets, in the series style.
 */

import { characterRefs, generateSoftly, styleReference, styleText, type StudioContext } from "@hoi-sau/studio";

export const REST_SIZE = "1024x1536";

export function restPrompt(ctx: StudioContext, slug: string): string {
  const p = ctx.profiles.get(slug);
  if (!p) throw new Error(`No character "${slug}".`);
  const style = ctx.style ? styleText(ctx.style) : p.look.style;
  return [
    `Full-body character turnaround reference, front view only, of ${p.name}: ${p.look.description}`,
    `Signature features: ${p.look.signature.join("; ")}. Draw exactly these features and nothing extra: no additional horns, ears, tails or limbs.`,
    "Pose: standing straight in a relaxed A-pose, facing the viewer, both arms held down and slightly away from the body with a clear gap of background between each arm and the torso, legs apart with a clear gap between them, feet flat, fingers visible, calm happy face.",
    "The whole body fits in the frame with empty margin on every side, centred. Plain flat pure white background, no floor, no shadow, no props in the hands, no text, nothing else in the picture.",
    style,
  ].join(" ");
}

export async function drawRest(ctx: StudioContext, slug: string, log?: (s: string) => void): Promise<Buffer> {
  const refs = [...characterRefs(ctx, slug), styleReference(ctx.style)].filter((x): x is string => Boolean(x));
  if (!refs.length) log?.(`${slug} has no locked model sheet; drawing from the description alone.`);
  const res = await generateSoftly(ctx.image, { prompt: restPrompt(ctx, slug), size: REST_SIZE, references: refs }, log);
  return res.image;
}
