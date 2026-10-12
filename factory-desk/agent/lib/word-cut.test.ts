import assert from "node:assert/strict";
import { test } from "node:test";
import { wordPrefix } from "./word-cut.js";

const PATHS = "Please look at components/banking/transaction-list.tsx and https://example.com/very/long/path/name";

test("wordPrefix ends before a space when that keeps half the room, so a path or URL stays whole", () => {
  assert.equal(wordPrefix(PATHS, 75), "Please look at components/banking/transaction-list.tsx and");
  assert.equal(wordPrefix(PATHS, PATHS.length), PATHS);
});

test("wordPrefix falls back to a UAX #29 word boundary, then a grapheme, and leaves no trailing separator", () => {
  assert.equal(wordPrefix(PATHS, 45), "Please look at components/banking/transaction");
  assert.equal(wordPrefix(PATHS, 30), "Please look at components");
  assert.equal(wordPrefix("a".repeat(50), 11), "a".repeat(11));
  assert.equal(wordPrefix("👍".repeat(30), 15), "👍".repeat(7), "a surrogate pair is never split");
  assert.equal(wordPrefix("Offset shows, zero", 14), "Offset shows");
});

test("wordPrefix measures escaped text when given the escaper's length", () => {
  const escaped = (text: string) => text.replaceAll("<", "&lt;").length;
  assert.equal(wordPrefix("a <b> c d e f", 9), "a <b> c d");
  assert.equal(wordPrefix("a <b> c d e f", 9, escaped), "a <b>", "`<` is four characters once escaped");
  assert.equal(wordPrefix("", -3), "");
});
