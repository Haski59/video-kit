"""Forced alignment of a known transcript against its audio (whisperX / wav2vec2).

Ported from scripts/edit/py/align_words.py, with one
fix: the output is INDEX-FOR-INDEX with the input. whisperX cannot time some tokens (it documents
"2014." and "£13.60" as unalignable) and simply omits their timings; the original skipped those
entries, so every later word's text would have been merged onto the wrong timing. Here an untimed
word is emitted as null and the caller keeps the decoder's timing for it.

whisper.cpp keeps the TEXT (Metal-fast, lexicon-primed); this only re-times it.

THE SEGMENT WINDOW MUST NEVER EXCEED THE AUDIO — a window longer than the file (one hallucinated
end time is enough) makes whisperX stretch the whole transcript to fit.

Usage: align_words.py <wav> <words.json> <out.json> <duration_sec>
  words.json: [{text,start,end}, ...]   out.json: [{start,end,score} | null, ...]  (same length)
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")
WINDOW_SEC = 30.0


def main() -> int:
    wav, words_path, out_path, duration = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
    words = json.load(open(words_path))
    if not words:
        json.dump([], open(out_path, "w"))
        return 0

    import whisperx

    device = "cpu"
    model_a, meta = whisperx.load_align_model(language_code="en", device=device)

    # Windows of consecutive words, remembering which input indices each window covers.
    segments, spans, cur, seg_start = [], [], [], max(0.0, float(words[0]["start"]))
    for i, w in enumerate(words):
        cur.append(i)
        if float(w["end"]) - seg_start >= WINDOW_SEC:
            segments.append({"start": seg_start, "end": min(float(w["end"]), duration), "text": " ".join(words[k]["text"].strip() for k in cur)})
            spans.append(cur)
            cur, seg_start = [], min(float(w["end"]), duration)
    if cur:
        segments.append({"start": seg_start, "end": min(float(words[cur[-1]]["end"]), duration), "text": " ".join(words[k]["text"].strip() for k in cur)})
        spans.append(cur)
    for s in segments:
        s["end"] = min(s["end"], duration)
        if s["end"] <= s["start"]:
            s["end"] = min(s["start"] + 0.05, duration)

    audio = whisperx.load_audio(wav)
    out = [None] * len(words)
    for seg, idx in zip(segments, spans):
        aligned = whisperx.align([seg], model_a, meta, audio, device, return_char_alignments=False)
        got = [w for s in aligned.get("segments", []) for w in s.get("words", [])]
        if len(got) != len(idx):
            # Token count drifted (whisperX re-split something). Index mapping would be a guess:
            # leave the whole window untimed rather than mis-assign timings.
            print(f"window {seg['start']:.1f}s: {len(got)} aligned tokens for {len(idx)} words — left untimed", file=sys.stderr)
            continue
        for k, w in zip(idx, got):
            if "start" in w and "end" in w:
                out[k] = {"start": round(float(w["start"]), 3), "end": round(float(w["end"]), 3), "score": round(float(w.get("score", 0.0)), 3)}
    json.dump(out, open(out_path, "w"))
    timed = sum(1 for x in out if x)
    print(f"aligned {timed} of {len(words)} words", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
