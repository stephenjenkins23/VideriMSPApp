/**
 * `is_blackscreen` / `is_showing_logo` parser tests —
 *   `node --test dist/videri/screen-verbs.test.js`
 *
 * The output shape of these two verbs is documented nowhere; the live shape
 * pinned below was captured off hardware 2026-09-01, on ONE device class. So the
 * parsers accept every plausible form and refuse everything else, and these
 * tests pin both halves: the forms we accept, and — more important here — the
 * ones we must decline rather than guess, because a wrong boolean flips the
 * verdict on a CRITICAL alert instead of nudging a number.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIsBlackscreen, parseIsShowingLogo, readScreenState } from "./telemetry.js";

test("a bare true/false is read, in any casing", () => {
  assert.equal(parseIsBlackscreen("true"), true);
  assert.equal(parseIsBlackscreen("False"), false);
  assert.equal(parseIsBlackscreen("  TRUE  "), true);
  assert.equal(parseIsShowingLogo("no"), false);
  assert.equal(parseIsShowingLogo("Yes"), true);
});

test("key=value and key:=value are read", () => {
  assert.equal(parseIsBlackscreen("is_blackscreen=true"), true);
  assert.equal(parseIsBlackscreen("is_blackscreen:=false"), false);
  assert.equal(parseIsBlackscreen("blackscreen = True"), true);
  assert.equal(parseIsShowingLogo("showing_logo=false"), false);
  assert.equal(parseIsShowingLogo("is_showing_logo:=true"), true);
});

test("the REAL live shapes, captured 2026-09-01 off a SparkBridge+", () => {
  // The only shapes we have actually seen on hardware. Both arrive in `message`
  // with an empty `others`, as prose with the boolean on the end — neither a
  // bare token nor a key=value, which is why the parser accepts all three.
  assert.equal(parseIsBlackscreen("Black Screen: true"), true);
  assert.equal(parseIsBlackscreen("Black Screen: false"), false);
  assert.equal(parseIsShowingLogo("Currently showing logo: false"), false);
  assert.equal(parseIsShowingLogo("Currently showing logo: true"), true);
});

test("the prose shape the sibling is_showing_overlay documents is read", () => {
  // `is_showing_overlay: "returns overlay showing: True/False"` — so at least
  // one verb on this shell answers as a sentence with a boolean on the end.
  assert.equal(parseIsShowingLogo("logo showing: True"), true);
  assert.equal(parseIsBlackscreen("black screen: False"), false);
  assert.equal(parseIsBlackscreen("Screen is black: true"), true);
});

test("JSON in `others` (via commandMessage) is read", () => {
  assert.equal(parseIsBlackscreen('{"message_json":{"is_blackscreen":true}}'), true);
  assert.equal(parseIsBlackscreen('{"is_black_screen":"false"}'), false);
  assert.equal(parseIsShowingLogo('{"message_json":{"showing_logo":false}}'), false);
  // A scalar answer carried in a generic field, and a bare JSON boolean.
  assert.equal(parseIsShowingLogo('{"message_json":{"value":"true"}}'), true);
  assert.equal(parseIsBlackscreen("true"), true);
});

test("a multi-field reply is read by NAME, not by position", () => {
  // Positional reading here would answer the black question with the logo's value.
  assert.equal(parseIsBlackscreen("blackscreen=false logo=true"), false);
  assert.equal(parseIsShowingLogo("blackscreen=false logo=true"), true);
  assert.equal(parseIsBlackscreen('{"message_json":{"is_showing_logo":true,"is_blackscreen":false}}'), false);
});

test("an unrecognised body is null, never a guess", () => {
  for (const body of [
    "", "   ", "Unknown command", "ERROR", "Invalid path: /storage/sdcard1",
    "logo=videri_default.png", "screen state unavailable",
    '{"message_json":{"brightness":0}}', "[]", "null",
  ]) {
    assert.equal(parseIsBlackscreen(body), null, `black: ${body}`);
    assert.equal(parseIsShowingLogo(body), null, `logo: ${body}`);
  }
});

test("a bare 1/0 is refused on purpose", () => {
  // Indistinguishable from a count, an index or an exit code on this shell. The
  // cost of a wrong answer here is a flipped CRITICAL verdict, so it stays null.
  assert.equal(parseIsBlackscreen("1"), null);
  assert.equal(parseIsBlackscreen("0"), null);
  assert.equal(parseIsBlackscreen("blackscreen=1"), null);
});

test("a reply the parser cannot attribute to one field is null, not the last field", () => {
  // Two key=value pairs, neither named anything we recognise: answering from
  // whichever came last would be a coin flip dressed as a reading.
  assert.equal(parseIsBlackscreen("foo=false, bar=true"), null);
});

// ─── readScreenState ──────────────────────────────────────────────────────────

test("readScreenState sends exactly the two read verbs", async () => {
  const args: string[] = [];
  await readScreenState(async (arg) => {
    args.push(arg);
    return { code: "SUCCESS", message: "false" };
  });
  assert.deepEqual([...args].sort(), ["is_blackscreen", "is_showing_logo"]);
});

test("readScreenState is field-independent: one verb failing does not lose the other", async () => {
  const s = await readScreenState(async (arg) =>
    arg === "is_blackscreen"
      ? { code: "SUCCESS", message: "false" }
      : { code: "ERROR", message: "Unknown command" });
  assert.equal(s.isBlack, false);
  assert.equal(s.isShowingLogo, null);
  assert.deepEqual(s.read, ["is_blackscreen"]);
});

test("readScreenState takes the payload from `others` when `message` is empty", async () => {
  // The reply-shape trap: a `message`-only read reports both verbs as silent,
  // which looks exactly like hardware that does not support them.
  const s = await readScreenState(async (arg) => ({
    code: "SUCCESS",
    message: "",
    others: { message_json: { [arg]: true } },
  }));
  assert.equal(s.isBlack, true);
  assert.equal(s.isShowingLogo, true);
  assert.deepEqual(s.read.sort(), ["is_blackscreen", "is_showing_logo"]);
});

test("a silent device yields nulls and an empty read list", async () => {
  const s = await readScreenState(async () => ({ code: "TIME_OUT", message: "" }));
  assert.equal(s.isBlack, null);
  assert.equal(s.isShowingLogo, null);
  assert.deepEqual(s.read, []);
});

test("SUCCESS with an unparseable body does not count as an answer", async () => {
  const s = await readScreenState(async () => ({ code: "SUCCESS", message: "not a boolean" }));
  assert.equal(s.isBlack, null);
  assert.deepEqual(s.read, [], "the verb replied, but it did not answer the question");
});
