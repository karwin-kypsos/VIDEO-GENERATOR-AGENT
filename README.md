# Video Generator Agent

One command turns a brief into a narrated, captioned video for social media or your website.

- **Script** — written by Claude from your brief (or bring your own storyboard).
- **Voice** — ElevenLabs, with word-level timing so captions and visuals follow the voice.
- **Picture** — rendered locally in headless Chrome and encoded with ffmpeg. No editor, no timeline.
- **UI screens are optional.** Give it screenshots or a URL and it builds the video around them;
  give it nothing and it makes the video from animated titles, bullet points, stats and quotes.

It runs on its own from a terminal — no IDE or chat session needed.

```bash
vidgen make "Announce our new analytics dashboard to store owners" --screens ./screens --name dashboard-launch
```

```
✓ Writing the storyboard — 7 scenes, 81 words
✓ Generating voice with ElevenLabs — voice "Brian", 7 clips
✓ Rendering 1143 frames at 1080x1920
✓ Mixing audio and writing the MP4

🎬 out/dashboard-launch/dashboard-launch-reel.mp4
   38.1s · 7 scenes · 1080x1920 · made in 1m 7s
```

## Setup

Needs [Node.js](https://nodejs.org) 20.12 or newer and [ffmpeg](https://ffmpeg.org/download.html)
(`brew install ffmpeg` · `winget install ffmpeg` · `apt install ffmpeg`).

```bash
npm install
npx playwright install chromium     # once; downloads the browser used for rendering
cp .env.example .env                # then add your keys
npm link                            # optional: makes `vidgen` available everywhere
```

Without `npm link`, use `node bin/vidgen.js` wherever this page says `vidgen`.

| Key in `.env`         | Needed for                                                             |
| --------------------- | ---------------------------------------------------------------------- |
| `ELEVENLABS_API_KEY`  | the voice. Not needed for `--draft` previews.                          |
| `ELEVENLABS_VOICE_ID` | which voice to use. `vidgen voices` lists the ones on your account.    |
| `ANTHROPIC_API_KEY`   | writing the script from a brief. Not needed if you pass a storyboard. |

Try it before adding any keys — this renders the bundled example as a silent preview:

```bash
npm run demo
```

## Making videos

```bash
# From a brief alone — no screens needed
vidgen make "Three reasons small shops switch to us" --duration 25

# Built around your UI screenshots (a folder, or individual files)
vidgen make "Show how fast checkout is" --screens ./screens

# From a public web page: it takes the screenshots itself
vidgen make --url https://yourbrand.com --format landscape

# Review the script before spending voice credits
vidgen plan "Launch post for the new mobile app" --screens ./screens
#   …edit out/<name>/storyboard.json if you like, then:
vidgen make --storyboard out/<name>/storyboard.json

# Same video, another shape
vidgen make --storyboard out/<name>/storyboard.json --format square
```

| Format      | Size      | For                                   |
| ----------- | --------- | ------------------------------------- |
| `reel`      | 1080×1920 | Reels, TikTok, Shorts, Stories        |
| `square`    | 1080×1080 | feed posts                            |
| `landscape` | 1920×1080 | YouTube, your website, LinkedIn       |

Useful options (`vidgen help` lists them all):

| Option                | What it does                                                           |
| --------------------- | ---------------------------------------------------------------------- |
| `--duration <s>`      | target length when writing the script (default 30)                     |
| `--voice <id\|name>`  | pick an ElevenLabs voice for this video                                |
| `--lang <language>`   | write and speak in this language                                       |
| `--music <file>`      | background music, mixed quietly under the voice                        |
| `--no-captions`       | leave out the word-by-word captions                                    |
| `--draft`             | fast silent preview — no ElevenLabs call, half the frame rate          |
| `--brand <file>`      | use a different brand file (one per client or product)                 |

Each run writes a folder under `out/`:

```
out/<name>/
  storyboard.json          the script and scene list (edit and re-render any time)
  screens/                 the screenshots it used
  <title>-reel.mp4         the video
  <title>-reel-cover.jpg   a cover frame
  <title>-reel.srt         subtitles, for platforms that take a caption file
```

Voice clips are cached in `.cache/tts`, so re-rendering after a visual tweak — or after rewording
one scene — only pays ElevenLabs for the lines that changed.

## Your brand

Edit `brand.json` once; every video picks it up.

```json
{
  "name": "Your Brand",
  "url": "yourbrand.com",
  "handle": "@yourbrand",
  "logo": "assets/logo.png",
  "tone": "confident, clear and friendly",
  "colors": { "bg": "#0B1020", "bg2": "#1A1F4B", "text": "#FFFFFF", "muted": "#AEB8D6", "accent": "#7C5CFF", "accent2": "#22D3EE" },
  "fonts": { "heading": "Plus Jakarta Sans", "body": "Inter" },
  "voice": { "id": "", "model": "", "stability": 0.5, "similarity": 0.75, "style": 0, "speed": 1 }
}
```

- `tone` steers how the script is written; `voice` holds the ElevenLabs settings.
- `voice.model` defaults to `eleven_multilingual_v2`. `eleven_flash_v2_5` is the fastest and
  cheapest; `ELEVENLABS_MODEL` in `.env` overrides both.
- The two bundled fonts need no installation. To use another, name a font installed on your
  machine, or add `"files": [{ "family": "My Font", "path": "fonts/MyFont.woff2" }]` under `fonts`.
- `"captions": false`, `"progressBar": false` and `"ambientMotion": false` switch those off.

## Storyboards

A storyboard is the whole video as JSON: an ordered list of scenes. Each scene's `narration` is
spoken, and the scene stays on screen for as long as that takes.

```json
{
  "title": "Pulse launch",
  "format": "reel",
  "scenes": [
    { "type": "title", "narration": "Your store makes money while you sleep. Do you know how much?",
      "kicker": "Meet Pulse", "headline": "Know your numbers *before* coffee" },
    { "type": "screen", "narration": "Pulse puts this week's revenue right at the top.",
      "image": "screens/app-home.png", "headline": "Revenue at a *glance*",
      "focusX": 50, "focusY": 27, "highlight": true },
    { "type": "cta", "narration": "Try Pulse free today.", "headline": "Start *free* today", "button": "Get Pulse" }
  ]
}
```

| Scene     | Shows                                              | Fields                                                                |
| --------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `title`   | a big statement                                    | `headline`\*, `kicker`, `subhead`                                     |
| `screen`  | a screenshot in a phone or browser frame, moving   | `image`\*, `headline`, `kicker`, `subhead`, `frame`, `motion`, `focusX`, `focusY`, `highlight` |
| `bullets` | points that appear as the voice reaches them       | `items`\* (up to 5), `headline`, `kicker`                             |
| `stat`    | one big number                                     | `value`\*, `label`, `kicker`                                          |
| `quote`   | a testimonial                                      | `quote`\*, `author`                                                   |
| `cta`     | closing call to action with your logo and link     | `headline`\*, `button`, `subhead`                                     |

\* required. Every scene also takes `narration`; a scene without it is silent and lasts `duration`
seconds (default 3).

- Wrap words in `*asterisks*` in a headline to highlight them.
- `image` paths are relative to the storyboard file.
- `frame`: `phone`, `browser`, `none`, or leave it out to choose from the image's shape.
- `motion`: `zoom-in`, `zoom-out`, `pan-down` (scrolls a tall page), `static`, or leave it out.
- `focusX` / `focusY`: the spot to push in on, as a percentage of the image's width and height
  from its top-left corner. `"highlight": true` adds a pulsing ring there.

See `examples/demo/` for a complete one.

### Using it from Claude in your editor

You don't need an Anthropic API key if an assistant is already at hand: ask Claude (in Antigravity,
VS Code, or anywhere else) to write a `storyboard.json` in this format, then run
`vidgen make --storyboard <file>`. `CLAUDE.md` in this repo tells it how.

## How it works

1. **Plan** — Claude gets the brief, your brand, the format and target length, and any screenshots
   (it looks at them, so narration matches what is on screen and it can point at the right spot).
   It returns the storyboard as structured JSON.
2. **Voice** — each scene's narration goes to ElevenLabs' timestamped speech endpoint, which
   returns the audio plus the timing of every character. That timing drives the captions and
   decides how long each scene lasts.
3. **Render** — each scene is an HTML page animated with CSS. Time is paused and stepped one frame
   at a time across several browser processes, so the result is identical on a fast or slow
   machine. Frames are piped straight into ffmpeg.
4. **Mix** — voice clips are placed on the timeline, music is added if given, and everything is
   written to a web-ready H.264/AAC MP4.

### Speed

Measured on a 4-core Linux VM: a 38-second 1080×1920 video at 30 fps renders in about 65 seconds;
a `--draft` of the same video takes about 35. More cores make it faster (one browser per core, up
to six; `VIDGEN_WORKERS` changes that cap). Script writing and voice add a few seconds each.

## Limits

- `--url` can only capture pages that are public. Social profiles and anything behind a login need
  screenshots passed with `--screens`.
- The script writer only states what is in your brief, the page text, or the screenshots. For
  numbers and testimonials to appear, put them in the brief.
- Visuals are motion graphics and screenshots. There is no stock footage or generated imagery.

## Development

```bash
npm test          # unit tests for timing, captions and storyboard handling
npm run demo      # end-to-end render of the bundled example (no keys needed)
```

```
bin/vidgen.js         CLI entry
src/cli.js            commands and options
src/pipeline.js       plan → voice → render → mix
src/planner.js        brief → storyboard (Claude)
src/tts.js            ElevenLabs speech, word timings, cache
src/timeline.js       scene lengths, caption and bullet timing
src/render.js         frame capture and segment encoding
src/capture.js        screenshots for --url
src/ffmpeg.js         audio mix, mux, cover frame
templates/            the scene design: scene.html, scene.css, scene.js
brand.json            your brand
```

To change how videos look, edit `templates/scene.css`. To add a scene type, add a builder in
`templates/scene.js`, its name in `src/storyboard.js`, and a line in the planner prompt in
`src/planner.js`.
