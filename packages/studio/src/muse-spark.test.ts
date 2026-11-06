import assert from "node:assert/strict";
import { test } from "node:test";
import { MuseSpark, retryDelayMs } from "./muse-spark.js";

type Reply = { status: number; body?: unknown; retryAfter?: string };

function scripted(replies: Reply[]) {
  const models: string[] = [];
  const transport = async (_url: string, init: { body: string }) => {
    models.push(JSON.parse(init.body).model);
    const r = replies.shift() ?? { status: 500 };
    return {
      status: r.status,
      json: async () => r.body ?? {},
      headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? r.retryAfter ?? null : null) },
    };
  };
  return { transport, models };
}

const ok = { status: 200, body: { choices: [{ message: { content: '{"a":1}' } }] } };

test("Contributor is the default; MUSE_SPARK_MODEL switches back", () => {
  assert.equal(MuseSpark.fromEnv({ META_API_KEY: "k" }).model, "muse-spark-1.3-contributor");
  assert.equal(MuseSpark.fromEnv({ META_API_KEY: "k", MUSE_SPARK_MODEL: "muse-spark-1.3" }).model, "muse-spark-1.3");
});

test("429 waits Retry-After and does not use up the 5xx retries", async () => {
  const waits: number[] = [];
  const { transport } = scripted([{ status: 429, retryAfter: "7" }, { status: 429 }, { status: 503 }, ok]);
  const spark = new MuseSpark({ apiKey: "k", transport, retries: 1, sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(await spark.json("t", {}, []), { a: 1 });
  assert.equal(waits[0], 7000);
  assert.equal(waits.length, 3);
});

test("a refused Contributor model falls back to Standard once", async () => {
  const { transport, models } = scripted([{ status: 403, body: { error: { message: "not available in your region" } } }, ok, ok]);
  const spark = MuseSpark.fromEnv({ META_API_KEY: "k" }, transport);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await spark.json("t", {}, []);
    await spark.json("t", {}, []);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(models, ["muse-spark-1.3-contributor", "muse-spark-1.3", "muse-spark-1.3"]);
});

test("fallback off: the 403 surfaces", async () => {
  const { transport } = scripted([{ status: 403 }]);
  const spark = MuseSpark.fromEnv({ META_API_KEY: "k", MUSE_SPARK_FALLBACK_MODEL: "none" }, transport);
  await assert.rejects(spark.json("t", {}, []), /403/);
});

test("retryDelayMs caps at 60 s", () => {
  assert.equal(retryDelayMs(0, "600"), 60_000);
  assert.ok(retryDelayMs(0) >= 1000 && retryDelayMs(0) < 1300);
});
