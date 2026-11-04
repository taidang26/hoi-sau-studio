import assert from "node:assert/strict";
import { test } from "node:test";
import { splitBeats } from "./idea.js";

test("typed text splits into set-up and punchline at the turn, keeping every word", () => {
  assert.deepEqual(splitBeats("Ai cũng xứng đáng có một công việc ổn định. Trừ tôi, tôi xứng đáng trúng số rồi nghỉ việc"), {
    top: "Ai cũng xứng đáng có một công việc ổn định.",
    punch: "Trừ tôi, tôi xứng đáng trúng số rồi nghỉ việc",
  });
  assert.deepEqual(splitBeats("Kiểm điểm bản thân ít thôi, trách đồng nghiệp nhiều vào"), { top: "Kiểm điểm bản thân ít thôi,", punch: "trách đồng nghiệp nhiều vào" });
  const s = splitBeats("Đi làm đã mệt rồi còn phải ăn bữa cơm dở ẹc do mình tự nấu mang theo");
  assert.equal(`${s.top} ${s.punch}`, "Đi làm đã mệt rồi còn phải ăn bữa cơm dở ẹc do mình tự nấu mang theo");
  assert.ok(s.punch.startsWith("còn"));
  assert.deepEqual(splitBeats("Thứ Hai"), { top: "Thứ Hai", punch: "" });
});
