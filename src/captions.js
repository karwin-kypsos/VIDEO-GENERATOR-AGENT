/**
 * Group timed words into the short chunks that are shown on screen one at a time.
 * A chunk closes when it is full, at the end of a sentence, or when the speaker pauses.
 */
export function chunkWords(words, { maxChars = 18, maxWords = 4, pauseGap = 0.45 } = {}) {
  const chunks = [];
  let current = [];
  let chars = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push({ start: current[0].start, end: current.at(-1).end, words: current });
    current = [];
    chars = 0;
  };

  words.forEach((word, i) => {
    const wouldBe = chars + (current.length ? 1 : 0) + word.text.length;
    if (current.length && (wouldBe > maxChars || current.length >= maxWords)) flush();
    current.push({ ...word });
    chars += (current.length > 1 ? 1 : 0) + word.text.length;

    const next = words[i + 1];
    const endsSentence = /[.!?…]["')\]]?$/.test(word.text);
    const pause = next ? next.start - word.end : 0;
    if (endsSentence || pause > pauseGap) flush();
  });
  flush();

  // A chunk stays up until the next one replaces it, so captions never flicker during short gaps.
  chunks.forEach((chunk, i) => {
    const next = chunks[i + 1];
    chunk.hideAt = next && next.start - chunk.end < 0.8 ? next.start : chunk.end + 0.25;
    chunk.words.forEach((word, j) => {
      const following = chunk.words[j + 1];
      word.until = following ? following.start : chunk.hideAt;
    });
  });
  return chunks;
}

/** Caption sizing per format: narrow frames get fewer words per chunk. */
export function captionOptions(formatName) {
  if (formatName === 'landscape') return { maxChars: 34, maxWords: 7 };
  if (formatName === 'square') return { maxChars: 24, maxWords: 5 };
  return { maxChars: 18, maxWords: 4 };
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/**
 * Sentence-level subtitles for uploading alongside the video.
 * @param {{start: number, words: {text: string, start: number, end: number}[]}[]} scenes timeline scenes;
 *   word times are relative to the scene's voice start, `voiceAt` is that start on the global timeline.
 */
export function buildSrt(scenes) {
  const cues = [];
  for (const scene of scenes) {
    if (!scene.words?.length) continue;
    for (const chunk of chunkWords(scene.words, { maxChars: 42, maxWords: 9, pauseGap: 0.6 })) {
      cues.push({
        start: scene.voiceAt + chunk.start,
        end: scene.voiceAt + chunk.end + 0.15,
        text: chunk.words.map((w) => w.text).join(' '),
      });
    }
  }
  return cues
    .map((cue, i) => {
      const end = cues[i + 1] ? Math.min(cue.end, cues[i + 1].start) : cue.end;
      return `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(end)}\n${cue.text}\n`;
    })
    .join('\n');
}
