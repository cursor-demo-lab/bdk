// Where Slack-bound text may be cut. A space is preferred, so a path, URL, or
// hyphenated word stays whole; then UAX #29 word boundaries, so CJK text
// breaks between dictionary words; then graphemes.

const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const TRAILING = /[\s,;:([{/\-–—]+$/u;

export function graphemes(text: string): string[] {
  return Array.from(GRAPHEMES.segment(text), (part) => part.segment);
}

/** UAX #29 words with a letter or digit, so a CJK sentence counts its words though it has no spaces. */
export function wordCount(text: string): number {
  let count = 0;
  for (const part of WORDS.segment(text)) if (part.isWordLike === true) count++;
  return count;
}

type Segment = { index: number; segment: string };

/**
 * The longest start of `text` whose `measure` (code units by default; an
 * escaper's output length for mrkdwn) is at most `room`, without trailing
 * spaces or `,;:([{/-–—`. It ends before a space, else between UAX #29 words,
 * each only when that keeps at least half the room; else between graphemes
 * (one long URL or hash), so a surrogate pair or emoji is never split.
 */
export function wordPrefix(text: string, room: number, measure: (text: string) => number = (part) => part.length): string {
  if (measure(text) <= room) return text;
  const end = (segments: Iterable<Segment>) => {
    let last = 0;
    let used = 0;
    let kept = 0;
    for (const { index, segment } of segments) {
      used += measure(segment);
      if (used > room) break;
      last = index + segment.length;
      kept = used;
    }
    return { last, enough: kept * 2 >= room };
  };
  const spaced = end(Array.from(text.matchAll(/\s*\S+/g), (match): Segment => ({ index: match.index, segment: match[0] })));
  const worded = spaced.enough ? spaced : end(WORDS.segment(text));
  const at = worded.enough ? worded.last : end(GRAPHEMES.segment(text)).last;
  return text.slice(0, at).replace(TRAILING, "");
}
