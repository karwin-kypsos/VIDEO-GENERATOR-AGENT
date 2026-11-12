import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadStoryboard, normalizeStoryboard, saveStoryboard } from '../src/storyboard.js';
import { slugify } from '../src/util.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-test-'));

test('missing fields get defaults; planner placeholders are cleaned up', () => {
  const { scenes } = normalizeStoryboard(
    { scenes: [{ type: 'title', narration: ' Hi ', headline: 'Hello', focusX: -1, focusY: -1, frame: 'auto', items: [''] }] },
    '/',
  );
  assert.equal(scenes[0].narration, 'Hi');
  assert.equal(scenes[0].focusX, null);
  assert.deepEqual(scenes[0].items, []);
  assert.equal(scenes[0].motion, 'auto');
  assert.equal(scenes[0].highlight, false);
});

test('every problem is reported at once, with scene numbers', () => {
  assert.throws(
    () =>
      normalizeStoryboard(
        { scenes: [{ type: 'title' }, { type: 'screen', image: 'nope.png' }, { type: 'wobble' }, { type: 'stat' }] },
        '/',
      ),
    (err) => {
      assert.match(err.userMessage, /Scene 1 \(title\): needs a "headline"/);
      assert.match(err.userMessage, /Scene 2 \(screen\): image not found/);
      assert.match(err.userMessage, /Scene 3: unknown type "wobble"/);
      assert.match(err.userMessage, /Scene 4 \(stat\): needs a "value"/);
      return true;
    },
  );
  assert.throws(() => normalizeStoryboard({ scenes: [] }, '/'), /at least one scene/);
});

test('a scene without narration gets a default length', () => {
  const { scenes } = normalizeStoryboard({ scenes: [{ type: 'title', headline: 'Silent' }] }, '/');
  assert.equal(scenes[0].duration, 3);
});

test('image paths resolve against the storyboard and survive a save/load round trip', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'screens'));
  fs.writeFileSync(path.join(dir, 'screens', 'a.png'), 'x');
  const file = path.join(dir, 'storyboard.json');
  const raw = {
    title: 'Round trip',
    scenes: [
      { type: 'screen', narration: 'Look.', image: 'screens/a.png', focusX: 20, focusY: 80, highlight: true },
      { type: 'cta', narration: 'Go.', headline: 'Go *now*', button: 'Start' },
    ],
  };
  const first = normalizeStoryboard(raw, dir);
  assert.equal(first.scenes[0].image, path.join(dir, 'screens', 'a.png'));
  saveStoryboard(first, file);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.scenes[0].image, 'screens/a.png');
  assert.equal('frame' in onDisk.scenes[0], false, 'defaults are not written out');
  assert.deepEqual(loadStoryboard(file), first);
});

test('the shipped demo storyboard is valid', () => {
  const demo = loadStoryboard(path.resolve('examples/demo/storyboard.json'));
  assert.equal(demo.scenes.length, 7);
});

test('slugs are safe folder names', () => {
  assert.equal(slugify('Hello, Wörld! 2026'), 'hello-world-2026');
  assert.equal(slugify('!!!'), 'video');
  assert.ok(slugify('a'.repeat(200)).length <= 48);
});
