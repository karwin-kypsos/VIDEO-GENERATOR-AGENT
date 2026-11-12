# Video Generator Agent

A CLI that turns a brief into a narrated, captioned MP4. Voice is always ElevenLabs. See
`README.md` for the full user guide and the storyboard reference.

## Making a video when asked

The user will usually say something like "make a reel about X" and may point at screenshots.

1. If `ANTHROPIC_API_KEY` is set in `.env`, let the tool write the script:
   `node bin/vidgen.js make "<brief>" [--screens <dir>] [--url <address>] [--format reel|square|landscape] [--duration <s>]`
2. Otherwise write the storyboard yourself, then render it:
   - Create `out/<name>/storyboard.json` (format in README → Storyboards). Put any screenshots in
     `out/<name>/screens/` and reference them as `screens/<file>`.
   - Look at each screenshot before writing about it, and set `focusX` / `focusY` to the spot the
     narration is about.
   - `node bin/vidgen.js make --storyboard out/<name>/storyboard.json`
3. Add `--draft` for a silent preview that costs no ElevenLabs credits. Use it while iterating on
   visuals or pacing, and drop it for the final render.

Writing a good storyboard:

- Open with a hook; end with a `cta` scene. One idea per scene, one or two short sentences.
- The voice reads about 2.6 words per second. A 30-second video is about 78 words in total.
- Captions already show the narration, so headlines should add to it, not repeat it. Headlines
  have at most 7 words; wrap the key word in `*asterisks*`.
- Only use numbers, quotes and claims the user gave you. This is published under their brand.

The finished files are listed at the end of the run. Report the path of the `.mp4`.

## Working on the code

- `npm test` runs the unit tests. `npm run demo` renders the bundled example end to end without
  any API keys; run it after touching `templates/`, `src/render.js` or `src/timeline.js` and look
  at a few frames of the result.
- Plain ESM JavaScript, Node 20.12+, no build step. Keep dependencies few.
- Everything that moves in a scene must be a CSS animation (or driven from `__seek` in
  `templates/scene.js`). The renderer pauses time and steps it frame by frame, so anything timed
  with `setTimeout`, `requestAnimationFrame` or CSS transitions will not appear in the video.
- Errors meant for the person running the CLI are thrown as `UserError` (`src/util.js`) with a
  message that says what to do next.
- `out/` and `.cache/` are generated; do not commit them.
