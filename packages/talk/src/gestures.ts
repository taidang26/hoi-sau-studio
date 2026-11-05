/**
 * The talking poses a character is drawn in once and reused in every video.
 * Descriptions are English because they go into Muse Image prompts; `vi` is
 * what the script writer sees.
 */

export interface Gesture {
  id: string;
  vi: string;
  pose: string;
  /** False when the face is too extreme for a blink to read (eyes popping). */
  blink: boolean;
}

export const GESTURES: Gesture[] = [
  { id: "explain", vi: "kể chuyện, một tay ngửa lòng bàn tay ngang ngực", pose: "one paw raised at chest height, palm up, explaining something to the viewer, friendly face", blink: true },
  { id: "point", vi: "chỉ thẳng vào người xem", pose: "pointing one finger straight at the viewer, eyebrows raised, knowing look", blink: true },
  { id: "shrug", vi: "nhún vai, hai tay ngửa, cười trừ", pose: "shrugging, both paws up and open at the sides, shoulders raised, awkward sheepish smile", blink: true },
  { id: "think", vi: "ngón tay chống cằm, mắt nhìn lên, nghĩ ngợi", pose: "one finger on the chin, eyes looking up and to the side, thinking hard, worried little frown", blink: true },
  { id: "shock", vi: "hai tay ôm má, mắt tròn xoe, sốc", pose: "both paws pressed on the cheeks, eyes huge and round, shocked, small sweat drops", blink: false },
  { id: "defend", vi: "giơ hai tay ôm đầu tự vệ (dạ em xin nhận)", pose: "both arms raised over the head in the slow loris defence pose, eyes huge, guilty and scared", blink: false },
];

export const gesture = (id: string): Gesture => GESTURES.find((g) => g.id === id) ?? GESTURES[0];
