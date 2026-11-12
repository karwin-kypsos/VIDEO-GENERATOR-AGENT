import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FORMATS } from './config.js';
import { make, plan } from './pipeline.js';
import { listVoices } from './tts.js';
import { UserError } from './util.js';

const HELP = `vidgen — brief in, narrated video out. Voice by ElevenLabs.

Usage
  vidgen make "<brief>" [options]         write the script, voice it, render the video
  vidgen make --storyboard <file.json>    render a storyboard you already have
  vidgen plan "<brief>" [options]         only write the storyboard, to review or edit
  vidgen voices [search]                  list the ElevenLabs voices on your account

What the video is made from (combine freely; all optional except one of them)
  "<brief>"               what the video should say, in your own words
  --brief-file <file>     read the brief from a text or markdown file
  --screens <dir|file>    UI screenshots to build the video around (repeatable)
  --url <address>         screenshot a public web page and use that
  --storyboard <file>     skip script writing and render this storyboard

Options
  --format <name>         ${Object.keys(FORMATS).join(' | ')} (default: reel)
  --duration <seconds>    target length when writing the script (default: 30)
  --voice <id|name>       ElevenLabs voice (default: ELEVENLABS_VOICE_ID, then brand.json)
  --lang <language>       language to write and speak in (default: language of the brief)
  --music <file>          background music, mixed quietly under the voice
  --no-captions           leave out the word-by-word captions
  --draft                 fast silent preview: no ElevenLabs call, 15 fps
  --brand <file>          brand settings (default: ./brand.json)
  --name <name>           folder name under out/
  --out <dir>             write everything to this folder instead
  --capture <device>      with --url: mobile | desktop (default: mobile for reel, else desktop)
  --fps <n>               frame rate (default: 30)

Formats
${Object.entries(FORMATS).map(([name, f]) => `  ${name.padEnd(10)} ${f.width}x${f.height}  ${f.label}`).join('\n')}

Examples
  vidgen make "Announce our new analytics dashboard to founders" --duration 25
  vidgen make "Show how easy sign-up is" --screens ./screens --format reel
  vidgen make --url https://example.com --format landscape
  vidgen make --storyboard out/my-video/storyboard.json --format square
`;

function parse(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'brief-file': { type: 'string' },
        screens: { type: 'string', multiple: true },
        url: { type: 'string' },
        storyboard: { type: 'string' },
        format: { type: 'string' },
        duration: { type: 'string' },
        voice: { type: 'string' },
        lang: { type: 'string' },
        music: { type: 'string' },
        'no-captions': { type: 'boolean' },
        draft: { type: 'boolean' },
        brand: { type: 'string' },
        name: { type: 'string' },
        out: { type: 'string' },
        capture: { type: 'string' },
        fps: { type: 'string' },
        'keep-work': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    throw new UserError(`${err.message}\nRun \`vidgen help\` to see the options.`);
  }
}

function positiveNumber(value, flag) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UserError(`${flag} needs a positive number, got "${value}".`);
  return n;
}

function toOptions(values, positionals) {
  let brief = positionals.join(' ').trim();
  if (values['brief-file']) {
    if (!fs.existsSync(values['brief-file'])) throw new UserError(`Brief file not found: ${values['brief-file']}`);
    brief = [brief, fs.readFileSync(values['brief-file'], 'utf8').trim()].filter(Boolean).join('\n\n');
  }
  if (values.capture && !['mobile', 'desktop'].includes(values.capture)) {
    throw new UserError('--capture must be "mobile" or "desktop".');
  }
  return {
    brief,
    screens: values.screens ?? [],
    url: values.url,
    storyboard: values.storyboard,
    format: values.format,
    duration: positiveNumber(values.duration, '--duration'),
    voice: values.voice,
    lang: values.lang,
    music: values.music ? path.resolve(values.music) : undefined,
    captions: values['no-captions'] ? false : undefined,
    draft: values.draft ?? false,
    brand: values.brand,
    name: values.name,
    out: values.out,
    capture: values.capture,
    fps: positiveNumber(values.fps, '--fps'),
    keepWork: values['keep-work'] ?? false,
  };
}

async function voicesCommand(search) {
  const voices = await listVoices(search || undefined);
  if (!voices.length) {
    console.log(search ? `No voices match "${search}".` : 'No voices on this account.');
    return;
  }
  const width = Math.min(34, Math.max(...voices.map((v) => v.name.length)));
  for (const v of voices) {
    const traits = [v.labels.gender, v.labels.accent, v.labels.age, v.labels.use_case ?? v.labels['use case']].filter(Boolean).join(', ');
    console.log(`${v.id}  ${v.name.slice(0, width).padEnd(width)}  ${v.category.padEnd(12)} ${traits}`);
  }
  console.log(`\n${voices.length} voice${voices.length === 1 ? '' : 's'}. Put the ID you want in .env as ELEVENLABS_VOICE_ID, or pass --voice.`);
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  const { values, positionals } = parse(rest);
  if (values.help) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'make':
      await make(toOptions(values, positionals));
      return;
    case 'plan': {
      const options = toOptions(values, positionals);
      if (options.storyboard) throw new UserError('`plan` writes a storyboard; it does not take --storyboard.');
      const { file } = await plan(options);
      const shown = path.relative(process.cwd(), file);
      console.log(`\n📝 ${shown}\n   Edit it if you like, then: vidgen make --storyboard ${shown}`);
      return;
    }
    case 'voices':
      await voicesCommand(positionals.join(' '));
      return;
    default:
      throw new UserError(`Unknown command "${command}". Run \`vidgen help\`.`);
  }
}
