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

test("one model: 429 waits Retry-After and does not use up the 5xx retries", async () => {
  const waits: number[] = [];
  const { transport } = scripted([{ status: 429, retryAfter: "7" }, { status: 429 }, { status: 503 }, ok]);
  const spark = new MuseSpark({ apiKey: "k", transport, retries: 1, sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(await spark.json("t", {}, []), { a: 1 });
  assert.equal(waits[0], 7000);
  assert.equal(waits.length, 3);
});

test("default rotation: Contributor 1.3, then 1.2 Contributor, then Standard", () => {
  assert.deepEqual(MuseSpark.fromEnv({ META_API_KEY: "k" }).rotation.models, ["muse-spark-1.3-contributor", "muse-spark-1.2-contributor", "muse-spark-1.3"]);
  assert.deepEqual(MuseSpark.fromEnv({ META_API_KEY: "k", MUSE_SPARK_MODELS: "a, b" }).rotation.models, ["a", "b"]);
  assert.deepEqual(MuseSpark.fromEnv({ META_API_KEY: "k", MUSE_SPARK_FALLBACK_MODEL: "none" }).rotation.models, ["muse-spark-1.3-contributor"]);
});

test("a rate-limited model hands over to the next at once, without waiting", async () => {
  const waits: number[] = [];
  const { transport, models } = scripted([{ status: 429, retryAfter: "30" }, ok, ok]);
  const spark = MuseSpark.fromEnv({ META_API_KEY: "k" }, transport);
  (spark as any).sleep = async (ms: number) => void waits.push(ms);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await spark.json("t", {}, []);
    await spark.json("t", {}, []);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(models, ["muse-spark-1.3-contributor", "muse-spark-1.2-contributor", "muse-spark-1.2-contributor"]);
  assert.equal(waits.length, 0);
});

test("a refused model is skipped; failing 5xx moves on after its retries", async () => {
  const { transport, models } = scripted([{ status: 403, body: { error: { message: "not available in your region" } } }, { status: 500 }, { status: 500 }, ok]);
  const spark = new MuseSpark({ apiKey: "k", transport, model: ["a", "b", "c"], retries: 1, sleep: async () => {} });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await spark.json("t", {}, []);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(models, ["a", "b", "b", "c"]);
  assert.equal(spark.model, "c");
});

test("no rotation: the 403 surfaces", async () => {
  const { transport } = scripted([{ status: 403 }]);
  const spark = MuseSpark.fromEnv({ META_API_KEY: "k", MUSE_SPARK_FALLBACK_MODEL: "none" }, transport);
  await assert.rejects(spark.json("t", {}, []), /403/);
});

test("retryDelayMs caps at 60 s", () => {
  assert.equal(retryDelayMs(0, "600"), 60_000);
  assert.ok(retryDelayMs(0) >= 1000 && retryDelayMs(0) < 1300);
});
