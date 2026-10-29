import { parentPort, workerData } from "node:worker_threads";
import { renderFrames } from "./render.js";

const { file, scene, first, from, to, work } = workerData;
renderFrames(file, scene, first, from, to, work, (n) => parentPort?.postMessage(n));
