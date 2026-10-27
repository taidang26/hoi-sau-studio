/**
 * Offline stand-in for the Responses endpoint, so the pipeline runs before an
 * API key exists. Draws the prompt's characters from their placeholder
 * portraits (see mock-art.ts), or a flat labelled tile when there are none.
 */

import { svgToPng } from "@hoi-sau/svg-text";
import { loadMockCast, renderScene, sceneFromPrompt, type Scene } from "./mock-art.js";
import type { Transport } from "./muse-image.js";

export function mockTransport(opts: { charactersDir?: string } = {}): { transport: Transport; calls: Array<Record<string, any>> } {
  const calls: Array<Record<string, any>> = [];
  const cast = loadMockCast(opts.charactersDir);
  const scenes = new Map<string, Scene>();
  const transport: Transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const [w, h] = String(body.tools?.[0]?.size ?? "1024x1024").split("x").map(Number);
    const n = calls.length;
    const prompt = typeof body.input === "string" ? body.input : body.input?.[0]?.content?.find?.((c: any) => c.type === "input_text")?.text ?? body.input?.[0]?.content?.[0]?.text ?? "";
    let svg: string;
    if (cast.length) {
      const scene = sceneFromPrompt(prompt, cast, n, body.previous_response_id ? scenes.get(body.previous_response_id) : undefined);
      scenes.set(`resp_mock_${n}`, scene);
      svg = renderScene(scene, w, h);
    } else {
      const label = prompt.slice(0, 60).replace(/[&<>]/g, "");
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <rect width="100%" height="100%" fill="hsl(${(n * 67) % 360} 45% 85%)"/>
      <circle cx="50%" cy="55%" r="${Math.min(w, h) / 12}" fill="#fff" stroke="#111" stroke-width="4"/>
      <text x="${w * 0.03}" y="${h * 0.97}" font-size="${w / 40}" fill="#111" font-family="Be Vietnam Pro">mock ${n}: ${label}</text></svg>`;
    }
    const png = svgToPng(svg);
    return {
      status: 200,
      json: async () => ({
        id: `resp_mock_${n}`,
        status: "completed",
        output: [
          { type: "reasoning", id: `rs_${n}` },
          { type: "message", id: `msg_${n}`, content: [{ type: "output_text", text: "mock render" }] },
          { type: "image_generation_call", id: `ig_${n}`, status: "completed", result: png.toString("base64") },
        ],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      }),
    };
  };
  return { transport, calls };
}

/**
 * Offline stand-in for Muse Spark chat completions. Answers each schema by
 * name with a small, valid Vietnamese draft built from the request, so the
 * whole episode pipeline runs end to end. `failReview` lists review calls
 * (1-based) that should fail, to exercise the redraw path.
 */
export function mockSparkTransport(opts: { failReview?: number[] } = {}): { transport: Transport; calls: Array<Record<string, any>> } {
  const calls: Array<Record<string, any>> = [];
  let reviews = 0;
  const transport: Transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const name: string = body.response_format?.json_schema?.name ?? "";
    const text = body.messages.map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join(" "))).join("\n");
    const cast: Array<{ slug: string; name: string; expressions: string[]; voice: { catchphrases: string[] } }> = (() => {
      const m = text.match(/Cast for this episode: (\[.*\])/);
      return m ? JSON.parse(m[1]) : [];
    })();
    const lead = cast[0] ?? { slug: "lead", name: "Nhân vật", expressions: ["default"], voice: { catchphrases: ["Ơ kìa"] } };
    const other = cast[1] ?? lead;
    // Four panels, unless the schema allows fewer (strip3 asks for exactly three, single for one).
    const props = body.response_format?.json_schema?.schema?.properties ?? {};
    const n = Math.min(4, props.beats?.maxItems ?? props.panels?.maxItems ?? 4);
    const idx = [...Array(n).keys()];
    let out: unknown;
    if (name === "character") out = mockCharacter(text.match(/Character idea: (.*)/)?.[1] ?? "nhân vật mới");
    else if (name === "premise")
      out = { title: `${lead.name} và cái deadline`, logline: `${lead.name} nhận việc gấp lúc 4h50 chiều.`, setup: "Sếp giao việc cuối ngày.", twist: `${other.name} hoá ra đã làm xong từ sáng.`, hook: "Ai sẽ báo sếp?", cameo: null };
    else if (name === "beats")
      out = { beats: (n === 1 ? (["punchline"] as const) : n === 3 ? (["setup", "escalation", "punchline"] as const) : (["setup", "escalation", "twist", "hook"] as const)).map((purpose, i) => ({ purpose, what_happens: `Nhịp ${i + 1}: ${purpose}` })) };
    else if (name === "script")
      out = {
        title: `${lead.name} và cái deadline`,
        panels: idx.map((i) => {
          const who = i % 2 ? [lead.slug, other.slug] : [lead.slug];
          return {
            beat: i,
            setting: "Phòng làm việc mở",
            characters: who,
            action: `Khung ${i + 1}: ${who.join(" và ")} ở bàn làm việc`,
            expressions: [{ character: lead.slug, expression: lead.expressions[i % lead.expressions.length] ?? "default" }],
            // Lines from the speakers' own catchphrases; the last panel stays silent.
            // The opening line is a thought and the second a shout, so offline runs show every balloon.
            dialogue:
              i === n - 1
                ? []
                : [
                    {
                      speaker: who[i % who.length],
                      text: (i % 2 ? other : lead).voice.catchphrases[i === 2 ? 1 : 0] ?? lead.voice.catchphrases[0],
                      kind: i === 0 ? "thought" : i === 1 ? "shout" : "speech",
                    },
                  ],
          };
        }),
      };
    else if (name === "storyboard") {
      const shots = ["wide", "medium", "medium", "close-up"].slice(4 - n);
      out = { panels: shots.map((shot) => ({ shot, angle: "eye level", composition: "Open-plan office desk, afternoon light.", staging: [{ character: lead.slug, position: "left" }, { character: other.slug, position: "right" }] })) };
    } else if (name === "review") {
      reviews++;
      out = opts.failReview?.includes(reviews)
        ? { pass: false, issues: [{ character: lead.slug, feature: "palette", problem: "fur colour drifted" }], fix: "restore the fur colour from the model sheet" }
        : { pass: true, issues: [], fix: "" };
    } else if (name === "safety") {
      // Flags texts with an obviously unsafe word; the rule half of the gate does the rest.
      const texts: Array<{ where: string; text: string }> = JSON.parse(text.match(/TEXTS_JSON: (\[.*\])/)?.[1] ?? "[]");
      const issues = texts.filter((t) => /chính trị|chinh tri|chiến tranh|tình dục/i.test(t.text)).map((t) => ({ where: t.where, topic: "unsafe", detail: "mock: unsafe word" }));
      out = { pass: !issues.length, issues };
    } else if (name === "recap") out = { summary: (text.split("EPISODE:\n")[1] ?? "").split("\n").slice(0, 2).join(" ") || "Một ngày ở văn phòng.", threads_closed: [], threads_opened: [] };
    else if (name === "canon") out = { facts: [{ fact: `${other.name} đã làm xong việc từ sáng mà không nói với ai`, characters: [other.slug] }] };
    else throw new Error(`mock Muse Spark has no answer for schema "${name}"`);
    return {
      status: 200,
      json: async () => ({ id: `chat_mock_${calls.length}`, choices: [{ message: { role: "assistant", content: JSON.stringify(out) } }] }),
    };
  };
  return { transport, calls };
}

function mockCharacter(idea: string) {
  const name = /mèo/i.test(idea) ? "Mimi" : "Gibbo";
  return {
    name,
    species: "black-crested gibbon (vượn đen má trắng)",
    office_type: "Người làm việc muộn",
    core_gag: "Luôn đến muộn đúng 5 phút nhưng có lý do rất thuyết phục",
    role: "Nhân viên thiết kế, hay đổi font",
    want: "Một lần đến đúng giờ mà có người chứng kiến",
    fear: "Thang máy dừng ở từng tầng",
    contradiction: "Đến muộn nhưng luôn là người về muộn nhất",
    edge: "Tối về là cao thủ cờ tướng vỉa hè, ván nào cũng gài bẫy",
    life: ["27 tuổi, ở trọ gần hồ", "Nuôi một con mèo tên Font", "Đi làm bằng xe buýt số 32"],
    comic_engine: ["Tay dài với tới mọi thứ trong phòng mà không cần đứng dậy", "Lý do đến muộn dài thành cả một khung truyện"],
    relationships: [],
    look: {
      description: "A small round gibbon with long arms, black fur and white cheek patches. Wears a mustard cardigan and carries a sketchbook.",
      signature: ["white cheek patches", "very long arms", "mustard cardigan"],
      palette: [
        { name: "fur", hex: "#2b2b2b" },
        { name: "cheeks", hex: "#f4f1ea" },
        { name: "cardigan", hex: "#d9a42b" },
      ],
      props: ["sketchbook"],
      expressions: [
        { name: "default", look: "calm half smile" },
        { name: "stressed", look: "arms wrapped around head" },
        { name: "happy", look: "swinging from the lamp" },
      ],
    },
    personality: ["Hiền", "Hay quên", "Giỏi biện minh", "Tốt bụng"],
    voice: { register: "Thân mật", speech_pattern: "Kể lể dài rồi chốt một câu", catchphrases: ["Em giải thích được!"], sample_lines: ["Em giải thích được, anh nghe em nói đã."] },
    never_says: ["Không chê ai chậm"],
  };
}
