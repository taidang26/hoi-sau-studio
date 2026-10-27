#!/usr/bin/env node
// The dashboard on Cloud Run, behind Firebase Hosting for the custom domains.
//
//   npm run cloud -- demo     sample data, nothing real: safe to leave open for judges
//   npm run cloud -- admin    real data and tokens, behind DASHBOARD_PASSWORD
//   npm run cloud -- env      upload .env to the bucket (after a token changes here)
//   npm run cloud -- seed     upload data/ and episodes/ to the bucket, once
//   npm run cloud -- down demo|admin
//
// The admin keeps data/, episodes/, output/, characters/, series/ and .env in a
// private Cloud Storage bucket mounted into the container (deploy/start.sh), so
// nothing is lost when Cloud Run replaces the container.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROJECT = process.env.GCP_PROJECT || "testmsbmusic-ai";
const REGION = process.env.GCP_REGION || "asia-southeast1";
const BUCKET = `gs://${PROJECT}-hoisau`;

function run(cmd, args, { optional = false } = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0 && !optional) process.exit(res.status ?? 1);
  return res.status === 0;
}

const gcloud = (...args) => run("gcloud", [...args, "--project", PROJECT]);
const firebase = (target) => run("firebase", ["deploy", "--only", `hosting:${target}`, "--project", "default"]);

function ensureBucket() {
  if (spawnSync("gcloud", ["storage", "buckets", "describe", BUCKET, "--project", PROJECT], { shell: process.platform === "win32", stdio: "ignore" }).status === 0) return;
  gcloud("storage", "buckets", "create", BUCKET, "--location", REGION, "--uniform-bucket-level-access", "--public-access-prevention");
}

function uploadEnv() {
  const env = join(ROOT, ".env");
  if (!existsSync(env) || !/^\s*DASHBOARD_PASSWORD\s*=\s*\S/m.test(readFileSync(env, "utf8"))) {
    throw new Error("Add DASHBOARD_PASSWORD=<a long password> to .env first: the admin is on the internet.");
  }
  ensureBucket();
  gcloud("storage", "cp", env, `${BUCKET}/.env`);
}

const deploy = (service, extra) =>
  gcloud("run", "deploy", service, "--source", ".", "--region", REGION, "--allow-unauthenticated", "--memory", "2Gi", "--cpu", "1", ...extra);

const commands = {
  demo() {
    deploy("hoisau-demo", ["--args=--demo", "--max-instances", "2"]);
    firebase("demo");
  },
  admin() {
    uploadEnv();
    deploy("hoisau-admin", [
      "--execution-environment", "gen2",
      "--add-volume", `name=store,type=cloud-storage,bucket=${BUCKET.slice(5)}`,
      "--add-volume-mount", "volume=store,mount-path=/mnt/store",
      "--set-env-vars", "STORE_DIR=/mnt/store",
      // Episodes are drawn in the background after the request returns: keep the CPU,
      // and one instance so the running jobs and the files agree.
      "--no-cpu-throttling", "--max-instances", "1", "--timeout", "3600",
    ]);
    firebase("admin");
  },
  env: uploadEnv,
  seed() {
    ensureBucket();
    for (const d of ["data", "episodes", "output", "characters", "series"]) {
      if (existsSync(join(ROOT, d))) gcloud("storage", "cp", "-r", d, `${BUCKET}/`);
    }
  },
  down([which]) {
    if (!["demo", "admin"].includes(which)) throw new Error("down demo | down admin");
    gcloud("run", "services", "delete", `hoisau-${which}`, "--region", REGION, "--quiet");
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log("Usage: npm run cloud -- demo | admin | env | seed | down <demo|admin>");
  process.exit(cmd ? 1 : 0);
}
try {
  await commands[cmd](args);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
