# Meme library cleanup — ongoing task

Two goals for the bundled library (`memes/manifest.json` + `memes/img/`, 868
templates, built by `tools/fetch-memes.py`):

1. **Expected text objects:** opening a template drops in ready-positioned text
   layers where that meme's captions normally go (e.g. Drake: right of each panel;
   Distracted Boyfriend: a label on each person), instead of a bare image.
2. **No duplicates:** each template appears once, under its best name and the
   cleanest image.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Part A — Remove duplicates
Baseline (2026-10-22): **0 byte-identical files**, so duplicates are the same
template from different sources (memegen / imgflip API / memeflow / imgflip
scrape) under different names, resolutions or watermarks. A quick 256-bit
dHash pass (Hamming ≤ 20) found **64 groups, ~83 removable**, e.g.
`A center for ants?` / `What is this, a Center for Ants?!`,
`BEST I CAN DO IS` / `Pawn Stars Best I Can Do`, `Bell Curve` / `Midwit`.

- [ ] `tools/dedupe-memes.py`: perceptual hash (dHash + pHash) every image,
      cluster by Hamming distance, write a review report (HTML contact sheet of
      each cluster) instead of deleting outright.
- [ ] Handle false positives: near-blank / flat images cluster together
      (`Blank White Template`, `Blank Transparent Square`, `Keep Calm…`) —
      skip images with low variance, and require aspect ratios to match.
- [ ] Pick the keeper per cluster: no watermark > highest resolution >
      memegen source; keep the clearest name and record the others as `aliases`
      in the manifest so search still finds them.
- [ ] Fix name junk while here: HTML entities (`&quot;`, `&amp;`), mojibake
      (`Why shouldn�t`), `meme template` suffixes.
- [ ] Move the dedupe into `fetch-memes.py` so a re-fetch doesn't bring the
      duplicates back (today it dedupes by normalised name only).
- [ ] Delete orphaned image files; check the manifest and folder agree.

## Part B — Expected text objects per template
Manifest entries are just `{ name, file }` today. Add a `boxes` array the editor
turns into text layers on open:

```json
{ "name": "Drake Hotline Bling", "file": "drake.jpg", "aliases": [],
  "boxes": [ { "x": 0.75, "y": 0.25, "w": 0.48, "h": 0.45, "text": "", "align": "center",
               "style": "impact" }, … ] }
```
(x/y/w/h as fractions of the image so they survive resizing; `style` picks a
preset: classic white Impact with black outline vs. black-on-white label text.)

- [ ] Define the schema + loader: `app.js` creates one auto-fit text layer per
      box when a bundled template is opened (falls back to today's behaviour
      when `boxes` is missing). Empty boxes show placeholder text ("Top text").
- [ ] Source 1 — **memegen** (~210 templates): its template configs carry real
      text positions (anchor x/y, scale, alignment, style). Pull them in
      `fetch-memes.py` and convert.
- [ ] Source 2 — **imgflip**: API gives only `box_count`. Use it as the count
      and lay boxes out by a heuristic (1 → top, 2 → top/bottom, n → stacked
      panels) as a first pass.
- [ ] Source 3 — the long tail (imgflip scrape, memeflow, no metadata): auto-
      detect panels/blank regions as a first guess, then hand-check.
- [ ] Review tool: a page that steps through templates showing the boxes over
      the image, lets you drag/resize/add/delete boxes and saves back to the
      manifest. This is where most of the real work happens (~868 → ~785 after
      dedupe).
- [ ] Prioritise: do the ~100 most popular templates (imgflip top 100) by hand
      first, then the rest.
- [ ] Saved templates of type `template` already store whole scenes — make sure
      the new box layers save/load through that path unchanged.

## Order
Do Part A first: no point positioning text on templates that get deleted.

## Log
- 2026-10-22 — Task created. Baseline: 868 templates, 0 exact dupes, ~64
  near-dup clusters (rough dHash pass, includes some blank-image false positives).
