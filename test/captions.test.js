import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSrt, chunkWords } from '../src/captions.js';
import { estimateWords, wordsFromAlignment } from '../src/tts.js';

const timed = (sentence, step = 0.3) =>
  sentence.split(' ').map((text, i) => ({ text, start: i * step, end: i * step + step * 0.8 }));

test('chunks respect the character and word limits', () => {
  const chunks = chunkWords(timed('one two three four five six seven eight nine ten'), { maxChars: 12, maxWords: 3 });
  for (const chunk of chunks) {
    assert.ok(chunk.words.length <= 3);
    assert.ok(chunk.words.map((w) => w.text).join(' ').length <= 12);
  }
  assert.equal(chunks.flatMap((c) => c.words).length, 10);
});

test('a sentence end closes the chunk even when there is room left', () => {
  const chunks = chunkWords(timed('Hello there. Next bit'), { maxChars: 40, maxWords: 8 });
  assert.deepEqual(chunks.map((c) => c.words.map((w) => w.text).join(' ')), ['Hello there.', 'Next bit']);
});

test('a chunk stays up until the next one starts, and each word until the next word', () => {
  const [first, second] = chunkWords(timed('alpha beta gamma delta'), { maxChars: 11, maxWords: 2 });
  assert.equal(first.hideAt, second.start);
  assert.equal(first.words[0].until, first.words[1].start);
  assert.equal(first.words[1].until, first.hideAt);
  assert.ok(second.hideAt > second.end);
});

test('chunking does not modify the words it was given', () => {
  const words = timed('alpha beta gamma');
  chunkWords(words);
  assert.deepEqual(Object.keys(words[0]), ['text', 'start', 'end']);
});

test('character timings from ElevenLabs become word timings', () => {
  const text = 'Hi  there, you';
  const alignment = {
    characters: [...text],
    character_start_times_seconds: [...text].map((_, i) => i * 0.1),
    character_end_times_seconds: [...text].map((_, i) => i * 0.1 + 0.1),
  };
  const words = wordsFromAlignment(alignment);
  assert.deepEqual(words.map((w) => w.text), ['Hi', 'there,', 'you']);
  assert.ok(Math.abs(words[1].start - 0.4) < 1e-9);
  assert.ok(Math.abs(words[1].end - 1.0) < 1e-9);
  assert.deepEqual(wordsFromAlignment(null), []);
});

test('estimated timings are ordered and cover every word', () => {
  const words = estimateWords('Short words and considerably longer ones.');
  assert.equal(words.length, 6);
  words.forEach((w, i) => {
    assert.ok(w.end > w.start);
    if (i) assert.ok(w.start >= words[i - 1].end);
  });
});

test('subtitles are numbered, timed on the whole-video clock, and never overlap', () => {
  const srt = buildSrt([
    { voiceAt: 0.15, words: timed('First scene here.') },
    { voiceAt: 5, words: timed('Second scene.') },
    { voiceAt: 9, words: [] },
  ]);
  const cues = srt.trim().split('\n\n');
  assert.equal(cues.length, 2);
  assert.match(cues[0], /^1\n00:00:00,150 --> 00:00:0\d,\d{3}\nFirst scene here\.$/);
  assert.match(cues[1], /^2\n00:00:05,000 --> /);
});
