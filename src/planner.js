import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { WORDS_PER_SECOND } from './config.js';
import { makePreview } from './ffmpeg.js';
import { FRAMES, MOTIONS, SCENE_TYPES } from './storyboard.js';
import { UserError } from './util.js';

const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM = `You are the writer and director of short narrated videos for social media and websites.

You receive a brief, the brand, the target format and length, and sometimes screenshots of a product, website or social profile. You return a storyboard: an ordered list of scenes. A renderer turns your storyboard into the finished video with nobody in between: a text-to-speech voice reads each scene's narration, the scene's visuals stay on screen for exactly as long as that narration takes, and word-by-word captions of the narration are added automatically. What you write is what ships.

## Writing it

- Open with a hook. The first scene's narration has to earn the next three seconds: a sharp claim, question or promise. No greetings and no "in this video".
- One idea per scene, in one or two short sentences of narration. Write for the ear: plain words, contractions, and nothing that reads badly aloud (no URLs, emoji, hashtags or symbols in narration).
- The voice reads about ${WORDS_PER_SECOND} words per second. Size the whole script to the target length. Running over is worse than coming in a little short.
- On-screen text is the takeaway, not a transcript. Captions already show the narration, so a headline should add to what is being said rather than repeat it. Headlines have at most 7 words and bullets at most 6. Wrap the one or two words that matter most in a headline in *asterisks* to highlight them.
- End with a cta scene that tells the viewer exactly what to do next.
- State only facts, numbers, quotes and features that appear in the brief, the site text or the screenshots. Use stat scenes only for numbers you were given and quote scenes only for quotes you were given. If the brief is thin, lean on title and bullets scenes about the benefit instead of inventing specifics: the brand publishes this under its own name.

## Scene types

- title: a big statement. Uses headline (required), kicker, subhead.
- screen: a screenshot inside a phone or browser frame, with a slow camera move. Uses image (required), headline, kicker, frame, motion, focusX, focusY, highlight. The narration should be about what is visible in that screenshot. focusX and focusY mark the spot the narration is about, as percentages of the image's width and height measured from its top-left corner; the camera pushes in on that spot. Use -1 for both when the whole screen matters.
- bullets: a headline and two to four short points that appear one by one as the voice reaches them. Uses headline, items (required), kicker.
- stat: one big number. Uses value (required, such as "3x", "98%" or "10,000+"), label, kicker.
- quote: a testimonial. Uses quote (required), author.
- cta: the closing call to action, shown with the brand's logo and link. Uses headline (required), button, subhead.

Every scene carries every field. For fields a scene does not use, give an empty string, an empty list, "auto", -1 or false.

When screenshots are provided, build the video around them: most scenes between the hook and the call to action should be screen scenes, and one screenshot can appear in several scenes with different focus points. When there are none, tell the story with title, bullets, stat and quote scenes.`;

function storyboardSchema(imageNames) {
  const scene = z.object({
    type: z.enum(SCENE_TYPES),
    narration: z.string().describe('What the voice-over says during this scene.'),
    kicker: z.string().describe('Two or three words shown as a small label above the headline.'),
    headline: z.string().describe('Main on-screen text, at most 7 words. *Asterisks* highlight a word.'),
    subhead: z.string().describe('One supporting line under the headline.'),
    items: z.array(z.string()).describe('bullets scenes: two to four points, at most 6 words each.'),
    value: z.string().describe('stat scenes: the number as displayed, e.g. "3x".'),
    label: z.string().describe('stat scenes: what the number measures.'),
    quote: z.string().describe('quote scenes: the quote, without quotation marks.'),
    author: z.string().describe('quote scenes: who said it.'),
    button: z.string().describe('cta scenes: the action, in two to four words.'),
    image: z.enum(['', ...imageNames]).describe('screen scenes: the screenshot file to show.'),
    frame: z.enum(FRAMES).describe('Device frame around the screenshot. "auto" picks from the image shape.'),
    motion: z
      .enum(MOTIONS)
      .describe('Camera move. "pan-down" scrolls through a tall page. "auto" picks from the image shape.'),
    focusX: z.number().describe('0-100, or -1 for no particular focus point.'),
    focusY: z.number().describe('0-100, or -1 for no particular focus point.'),
    highlight: z.boolean().describe('Draw a pulsing ring on the focus point, to point at one control.'),
  });
  return z.object({
    title: z.string().describe('Short working title for the video, used for the file name.'),
    scenes: z.array(scene),
  });
}

function formatLine(format) {
  const shape = { reel: 'vertical 9:16', square: 'square 1:1', landscape: 'horizontal 16:9' }[format.name];
  return `${format.name}: ${shape}, ${format.width}x${format.height}. ${format.label}.`;
}

async function imageBlock(file, previewDir, index) {
  const preview = path.join(previewDir, `preview-${index}.jpg`);
  await makePreview(file, preview);
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(preview).toString('base64') },
  };
}

/**
 * Ask Claude to write the storyboard.
 *
 * @param {object} input
 * @param {string} input.brief what the video is about
 * @param {{name: string, file: string}[]} input.screens screenshots available to the video; `name`
 *   is the path the storyboard should reference, `file` is where the image is on disk
 * @param {{url: string, title: string, description: string, text: string}|null} input.site
 * @returns {Promise<object>} raw storyboard, ready for normalizeStoryboard()
 */
export async function planStoryboard({ brief, brand, format, targetSeconds, screens, site, language, workDir }) {
  const words = Math.round(targetSeconds * WORDS_PER_SECOND);
  const sceneCount = Math.min(12, Math.max(3, Math.round(targetSeconds / 5)));

  const content = [
    {
      type: 'text',
      text: [
        `<brief>\n${brief}\n</brief>`,
        `<brand>\nName: ${brand.name}\nWebsite: ${brand.url || 'not given'}\nHandle: ${brand.handle || 'not given'}\nTone of voice: ${brand.tone}\n</brand>`,
        `<format>${formatLine(format)}</format>`,
        `<target_length>${targetSeconds} seconds: about ${words} words of narration in total, in roughly ${sceneCount} scenes.</target_length>`,
        `<language>${language ? `Write narration and on-screen text in: ${language}.` : 'Write narration and on-screen text in the language of the brief.'}</language>`,
        site
          ? `<site url="${site.url}">\nTitle: ${site.title}\nDescription: ${site.description}\n\nText on the page:\n${site.text}\n</site>`
          : '',
        screens.length
          ? `<screenshots>${screens.length} screenshot${screens.length > 1 ? 's follow' : ' follows'}, each preceded by its file name.</screenshots>`
          : '<screenshots>None. This video has no screenshots.</screenshots>',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
  for (const [i, screen] of screens.entries()) {
    content.push({ type: 'text', text: `Screenshot file: ${screen.name}` });
    content.push(await imageBlock(screen.file, workDir, i));
  }

  const request = {
    model: process.env.VIDGEN_MODEL || DEFAULT_MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: 'user', content }],
    output_config: {
      effort: 'medium',
      format: zodOutputFormat(storyboardSchema(screens.map((s) => s.name))),
    },
  };

  let message;
  try {
    const client = new Anthropic();
    try {
      // If a safety classifier declines the request, the API re-runs it on a fallback model inside
      // the same call instead of failing the run.
      message = await client.beta.messages.parse({
        ...request,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (err) {
      // Accounts or platforms without server-side fallbacks reject the parameter; the plain
      // request is the same thing minus that safety net.
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      message = await client.messages.parse(request);
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new UserError('Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new UserError('Anthropic rate limit reached. Wait a minute and run the command again.');
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new UserError('Could not reach the Anthropic API. Check your connection.');
    }
    if (err instanceof Anthropic.APIError) {
      throw new UserError(`Anthropic API error ${err.status ?? ''}: ${err.message}`);
    }
    // Anything else happened before a request went out — most often no credentials were found.
    throw new UserError(
      `Could not call the Anthropic API: ${err.message}\n` +
        'Set ANTHROPIC_API_KEY in .env, or write the storyboard yourself and pass it with --storyboard (see README).',
    );
  }

  if (message.stop_reason === 'refusal') {
    throw new UserError('The model declined to write this storyboard. Rephrase the brief and try again.');
  }
  if (message.stop_reason === 'max_tokens' || !message.parsed_output) {
    throw new UserError('The storyboard came back incomplete. Try again, or shorten the target length.');
  }
  return message.parsed_output;
}
