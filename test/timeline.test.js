import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCENE_LEAD, SCENE_TAIL } from '../src/config.js';
import { buildTimeline, bulletTimes } from '../src/timeline.js';

const scene = (extra) => ({ type: 'title', narration: 'x', headline: 'x', items: [], duration: null, ...extra });
const clip = (duration, text = 'one two three') => ({
  file: '/tmp/a.mp3',
  duration,
  words: text.split(' ').map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.3 })),
});

test('scenes are whole frames long and sit back to back', () => {
  const timeline = buildTimeline({ scenes: [scene(), scene(), scene()] }, [clip(2.37), clip(3.01), clip(1.5)], {
    fps: 30,
    formatName: 'reel',
  });
  let expectedStart = 0;
  for (const s of timeline.scenes) {
    assert.ok(Number.isInteger(s.frames));
    assert.ok(Math.abs(s.start - expectedStart) < 1e-9);
    assert.ok(s.duration >= 1.8);
    expectedStart += s.frames / 30;
  }
  assert.equal(timeline.frames, timeline.scenes.reduce((n, s) => n + s.frames, 0));
  assert.ok(Math.abs(timeline.total - expectedStart) < 1e-9);
});

test('a scene lasts for its narration plus lead-in and tail', () => {
  const { scenes } = buildTimeline({ scenes: [scene(), scene()] }, [clip(3), clip(3)], { fps: 30, formatName: 'reel' });
  assert.ok(scenes[1].duration >= SCENE_LEAD + 3 + SCENE_TAIL);
  assert.ok(scenes[1].duration < SCENE_LEAD + 3 + SCENE_TAIL + 1 / 30 + 1e-9);
  assert.ok(Math.abs(scenes[1].voiceAt - (scenes[1].start + SCENE_LEAD)) < 1e-9);
  assert.ok(scenes[0].lead < SCENE_LEAD, 'the first scene starts talking sooner');
});

test('a silent scene uses its own duration', () => {
  const { scenes } = buildTimeline({ scenes: [scene({ narration: '', duration: 4 })] }, [null], { fps: 30, formatName: 'reel' });
  assert.equal(scenes[0].duration, 4);
  assert.equal(scenes[0].voiceFile, null);
  assert.deepEqual(scenes[0].captionChunks, []);
});

test('caption times are shifted by the lead-in; captions can be turned off', () => {
  const on = buildTimeline({ scenes: [scene()] }, [clip(2)], { fps: 30, formatName: 'reel' }).scenes[0];
  assert.ok(Math.abs(on.captionChunks[0].start - on.lead) < 1e-9);
  const off = buildTimeline({ scenes: [scene()] }, [clip(2)], { fps: 30, formatName: 'reel', captions: false }).scenes[0];
  assert.deepEqual(off.captionChunks, []);
});

test('bullets appear when the voice reaches them, in order, never bunched up', () => {
  const words = 'We track revenue daily and then orders plus every customer'
    .split(' ')
    .map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const times = bulletTimes(['Live revenue', 'All orders', 'Unmentioned thing'], words, 0.25, 5.5);
  assert.ok(Math.abs(times[0] - (0.25 + 1.0 - 0.15)) < 1e-6, 'revenue is spoken at 1.0s');
  assert.ok(Math.abs(times[1] - (0.25 + 3.0 - 0.15)) < 1e-6, 'orders is spoken at 3.0s');
  assert.ok(times[2] >= times[1] + 0.35);
  assert.ok(bulletTimes(['a', 'b'], [], 0.25, 2).every((t, i, all) => i === 0 || t >= all[i - 1] + 0.35));
});
