/**
 * kLattsch Avatar — 1B LLM + klattsch vocal synth + 3D human body
 *
 *  Text in  -> llama3.2:1b (Ollama) generates a reply
 *            -> klattsch engine: reply -> ARPABET phonemes -> synthesized WAV
 *            -> 3D human-body avatar (Three.js) lip-syncs to the audio
 *
 *  The klattsch engine here is the SAME open-source engine behind
 *  https://klatts.ch/play/
 *
 *  Human warmth: instead of a flat monotone, the phoneme stream is built
 *  word-by-word with natural pauses, and laced with the engine's prosody
 *  directives — vibrato (v/w), tremolo (m/n), breathiness (h), spectral
 *  tilt (t), vocal effort (g), sticky pitch glides (+N/-N), transient
 *  ornaments ((+N)/(-N)) and rate pushes (r+N/r-N). An "emotion" picks a
 *  voice character; the LLM can pick the emotion itself.
 */

const path = require('path');
const express = require('express');
const { pronounce, pronounceText } = require('klattsch/pronounce');
const { compileString, FormantSynth, encodeWav } = require('klattsch');

const app = express();

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const LLM_MODEL = process.env.LLM_MODEL || 'llama3.2:1b';
const PORT = process.env.PORT || 3000;
const SAMPLE_RATE = 24000; // plenty for formant synthesis, halves payload size

app.use(express.json({ limit: '2mb' }));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));
// Three.js served locally (no CDN needed)
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three/build')));
app.use('/vendor/three-addons', express.static(path.join(__dirname, 'node_modules/three/examples/jsm')));

/* ================================================================ *
 *  VOICE CHARACTER / EMOTION PROFILES
 *  Each profile drives the prosody directives so the same engine
 *  sounds warm, excited, calm, etc.
 * ================================================================ */
const PROFILES = {
  warm:      { base: 122, rate: 118, scale: 1.04, v: 3.5, w: 5.0, m: 0.04, n: 5.5, h: 0.06, t: 0.10, g: 0.55, prosody: 0.55 },
  excited:   { base: 152, rate: 98,  scale: 1.06, v: 5.0, w: 6.0, m: 0.08, n: 6.0, h: 0.04, t: 0.25, g: 0.75, prosody: 1.00 },
  calm:      { base: 100, rate: 150, scale: 0.98, v: 2.0, w: 4.0, m: 0.02, n: 4.5, h: 0.10, t: -0.10, g: 0.40, prosody: 0.30 },
  playful:   { base: 136, rate: 104, scale: 1.05, v: 5.5, w: 5.0, m: 0.06, n: 5.0, h: 0.05, t: 0.15, g: 0.65, prosody: 0.90 },
  sad:       { base: 94,  rate: 172, scale: 0.97, v: 2.5, w: 3.5, m: 0.03, n: 4.0, h: 0.13, t: -0.20, g: 0.35, prosody: 0.40 },
  serious:   { base: 106, rate: 132, scale: 1.00, v: 2.0, w: 4.0, m: 0.02, n: 5.0, h: 0.05, t: -0.05, g: 0.60, prosody: 0.50 },
  surprised: { base: 160, rate: 98,  scale: 1.07, v: 6.0, w: 7.0, m: 0.09, n: 7.0, h: 0.05, t: 0.30,  g: 0.70, prosody: 1.00 },
};

const EMOTIONS = Object.keys(PROFILES);

/* Deterministic seeded RNG so prosody is reproducible per render. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- *
 *  text -> phoneme string
 * ---------------------------------------------------------------- */

/** Strip anything that would not pronounce well through the formant engine. */
function sanitizeForSpeech(text) {
  return text
    .replace(/https?:\/\/\S+/g, ' ')          // urls
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // markdown links
    .replace(/[#*_`>|~]/g, ' ')               // markdown
    .replace(/[^\w\s.,!?'"$%&:;()\-]/g, ' ')  // everything else not speakable
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function wordToPhones(word) {
  const clean = word.replace(/[.,!?;:'"]+$/g, '').replace(/^[.,!?;:'"]+/g, '').toLowerCase();
  if (!clean) return null;
  const r = pronounce(clean);
  if (!r || !r.length) return null;
  return r.map((p) => p.code + (p.stressed ? '!' : '')).join(' ');
}

const PAUSE = { ',': ',', '.': '.', '!': '.', '?': '.', ';': ';' };

/**
 * Build an ARPABET phoneme string word-by-word so natural punctuation
 * becomes natural pause lengths: , = 100 ms, . = 200 ms, ; = 300 ms.
 */
function textToPhonemeString(text) {
  const words = sanitizeForSpeech(text).split(/\s+/);
  const out = [];
  let hadPause = false;

  for (const tok of words) {
    const trailing = (tok.match(/[.,!?;]+$/) || [''])[0];
    const word = tok.slice(0, tok.length - trailing.length);
    const phones = word ? wordToPhones(word) : null;

    if (phones) {
      if (!hadPause) {
        // separate from previous word with a short pause
        if (out.length) out.push(',');
      }
      out.push(phones);
    }
    if (trailing) {
      out.push(PAUSE[trailing[trailing.length - 1]] || ',');
    }
    hadPause = !!trailing;
  }
  return out.join(' ');
}

/* ---------------------------------------------------------------- *
 *  Human-warmth prosody: randomized ornaments, rate pushes,
 *  pitch wobble and breathing pauses woven through the phonemes.
 * ---------------------------------------------------------------- */
function addMicroProsody(phonemeString, intensity, rng) {
  if (!intensity || intensity <= 0) return phonemeString;
  const words = phonemeString.split(/,|;|\.| /).filter(Boolean); // rough token count
  const tokenList = phonemeString.split(/\s+/);
  const out = [];

  for (let i = 0; i < tokenList.length; i++) {
    let tok = tokenList[i];
    const isPause = /^[,.!?;]$/.test(tok);
    if (isPause) {
      // breathing: occasionally turn a pause into a longer one
      if (rng() < intensity * 0.25) tok = tok === ',' ? '.' : ';';
      out.push(tok);
      continue;
    }

    // tok is a word (space-separated phoneme group).
    // 1) transient pitch ornaments on random phones
    if (rng() < 0.25 + intensity * 0.4) {
      const phones = tok.split(/\s+/);
      const idx = Math.floor(rng() * phones.length);
      const up = rng() < 0.55;
      const amt = Math.round(5 + rng() * 14 * intensity);
      phones[idx] += up ? `(+${amt})` : `(-${amt})`;
      tok = phones.join(' ');
    }
    // 2) a sticky rising/falling glide on some words (carries warmth)
    if (rng() < intensity * 0.18) {
      const up = rng() < 0.5;
      const amt = Math.round(4 + rng() * 10 * intensity);
      tok = tok + (up ? ` +${amt}` : ` -${amt}`);
    }
    // 3) occasional rate push before a word, reset right after
    if (rng() < intensity * 0.22) {
      const faster = rng() < 0.5;
      const amt = Math.round(18 + rng() * 26 * intensity);
      out.push(faster ? `r-${amt}` : `r+${amt}`);
      out.push(tok);
      out.push('r'); // reset running rate
      continue;
    }
    out.push(tok);
  }
  return out.join(' ');
}

/** Compose the final directive + phoneme stream for one utterance. */
function buildPhonemeStream(text, opts = {}) {
  const emoKey = PROFILES[opts.emotion] ? opts.emotion : 'warm';
  const emo = PROFILES[emoKey];
  const rng = mulberry32(opts.seed ?? Math.floor(Math.random() * 1e9));

  // explicit UI sliders override profile; otherwise profile values
  const base = opts.pitch ?? emo.base;
  const rate = opts.rate ?? emo.rate;
  const v = opts.vibrato ?? emo.v;
  const w = opts.vibratoRate ?? emo.w;
  const m = opts.tremolo ?? emo.m;
  const n = opts.tremoloRate ?? emo.n;
  const h = opts.breathiness ?? emo.h;
  const t = opts.tilt ?? emo.t;
  const g = opts.effort ?? emo.g;
  const scale = emo.scale;
  // expressive strength: slider overrides profile's prosody level
  const prosody = opts.expressiveness ?? emo.prosody;

  // tiny human pitch wobble so even a flat line breathes
  const wobble = Math.round((rng() * 2 - 1) * (2 + prosody * 5));

  const basePhones = textToPhonemeString(text) || 'HH AH L OW';
  const stream = addMicroProsody(basePhones, Math.max(0, Math.min(1.2, prosody)), rng);

  const head = [
    `b${base + wobble}`,
    `r${rate}`,
    `s${scale.toFixed(2)}`,
    `v${v}`, `w${w}`,
    `m${m}`, `n${n}`,
    `h${h}`,
    `t${t}`,
    `g${g}`,
  ].join(' ');

  return { stream: `${head} ${stream}`, emotion: emoKey };
}

/** Render a full phoneme stream -> WAV bytes. */
function synthesize(text, opts = {}) {
  const { stream, emotion } = buildPhonemeStream(text, opts);
  const { schedule, totalMs } = compileString(stream);
  const synth = new FormantSynth({ sampleRate: SAMPLE_RATE, schedule });
  const buf = new Float32Array(Math.ceil((totalMs * SAMPLE_RATE) / 1000));
  synth.process(buf);
  const { bytes } = encodeWav(buf, SAMPLE_RATE);
  return { wav: bytes, stream, emotion, totalMs };
}

/* ================================================================ *
 *  API
 * ================================================================ */

app.get('/api/info', (_req, res) => {
  res.json({
    llm: LLM_MODEL,
    synth: 'klattsch (same engine as klatts.ch/play)',
    klatts: 'https://klatts.ch/play/',
    emotions: EMOTIONS,
    sampleRate: SAMPLE_RATE,
  });
});

const SYSTEM_PROMPT = `You are a retro speech-synthesizer avatar. Your voice is a 1970s-style
parallel-formant synthesizer (the open-source "klattsch" engine — the same one that powers
klatts.ch/play). A 3D human body lip-syncs everything you say.

Hard rules:
- Reply with AT MOST two short sentences, under 25 words total. Never use asterisks
  or stage directions like *pauses* — just speakable words.
- Plain, clearly-pronounceable English. No markdown, lists, URLs, or emojis.
- Be friendly, witty, and a little retro-computer-flavored.
- First, on its own line, emit ONE emotion tag from this exact list:
  [emotion:warm] [emotion:excited] [emotion:calm] [emotion:playful]
  [emotion:sad] [emotion:serious] [emotion:surprised]
  Pick the one that matches your reply's mood. Then reply on the next line.
  Example: [emotion:surprised]\nNo way, the Great Red Spot of Jupiter has been spinning for two hundred years!`;

/* Lightweight emotion classifier — fallback when the LLM skips its tag,
 * so the voice always gets character. */
const EMOTION_WORDS = {
  excited:  ['wow', 'amazing', 'incredible', 'awesome', 'great', 'love', 'excited', 'yes', 'no way', 'whoa', 'crazy', 'huge', 'best', 'fun', 'cool', 'yeah', 'oh'],
  surprised: ['surpris', 'no way', 'what', 'really', 'weird', 'strange', 'giant', 'tiny', 'whoa', 'never', 'can\'t believe', 'did you know', 'turns out'],
  calm:     ['calm', 'softly', 'gentle', 'peaceful', 'quiet', 'hmm', 'well', 'still', 'almost', 'slowly', 'flicker', 'breathe'],
  sad:      ['sad', 'sorry', 'bad', 'hard', 'lost', 'missing', 'afraid', 'alone', 'regret', 'tear'],
  playful:  ['fun', 'joke', 'silly', 'goofy', 'hehe', 'buddy', 'friend', 'guess', 'probably', 'maybe', 'ha'],
  serious:  ['serious', 'important', 'truth', 'fact', 'must', 'always', 'never', 'exactly', 'indeed', 'certain'],
  warm:     ['hello', 'hi', 'nice', 'good', 'friend', 'glad', 'thanks', 'please', 'welcome', 'warm', 'lovely'],
};

function classifyEmotion(text) {
  const t = ' ' + text.toLowerCase() + ' ';
  const scores = { warm: 0 };
  for (const [emo, words] of Object.entries(EMOTION_WORDS)) {
    let s = 0;
    for (const w of words) {
      if (t.includes(w)) s++;
    }
    if (emo !== 'warm') scores[emo] = s;
  }
  if ((t.match(/!/g) || []).length >= 2) {
    scores.excited += 1.5;
    scores.surprised += 0.5;
  }
  if (t.trim().endsWith('?')) scores.surprised += 1;
  if (/^i'm (so )?(happy|glad|excited)/.test(t)) scores.excited += 2;

  let best = 'warm';
  let bestScore = -1;
  for (const [emo, s] of Object.entries(scores)) {
    if (s > bestScore) { best = emo; bestScore = s; }
  }
  return best;
}

/** Cut a rambling LLM reply down to a speakable length. */
function condense(text) {
  let t = text.replace(/\s*\n+\s*/g, ' ').trim();
  if (t.length <= 170) return t;
  // keep the first 1-2 sentences
  const sentences = t.match(/[^.!?]+[.!?]+/g) || [t];
  let out = sentences[0];
  if (sentences[1] && out.length < 110) out += ' ' + sentences[1];
  out = out.trim().slice(0, 200);
  // don't leave a half word at the end
  const lastSpace = out.lastIndexOf(' ');
  if (lastSpace > 120) out = out.slice(0, lastSpace);
  return out.trim();
}

/**
 * Ask the 1B LLM for a reply and pull any emotion tag off the front.
 */
async function askLLM(messages) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      stream: false,
      options: { temperature: 0.8, num_predict: 160 },
    }),
  });
  if (!r.ok) throw new Error(`ollama responded ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const raw = (data.message?.content ?? '').trim();
  if (!raw) throw new Error('empty LLM response');

  // accept both [emotion:warm] and a bare [warm] tag
  const m = raw.match(/\[(?:emotion:)?([a-z]+)\]\s*/i);
  const emotion = m && PROFILES[m[1]]
    ? m[1]
    : classifyEmotion(raw);
  const text = condense(m && PROFILES[m[1]] ? raw.replace(/\[(?:emotion:)?[a-z]+\]\s*/i, '') : raw);
  return { text, emotion };
}

app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.slice(-10),
      { role: 'user', content: message },
    ];
    const { text, emotion } = await askLLM(messages);
    res.json({ text, emotion, model: LLM_MODEL });
  } catch (err) {
    console.error('/api/chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/speak', (req, res) => {
  const { text, emotion, pitch, rate, vibrato, breathiness, effort, expressiveness } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }
  try {
    const { wav, stream, emotion: used, totalMs } = synthesize(text, {
      emotion: emotion || 'warm',
      pitch: pitch || undefined,
      rate: rate || undefined,
      vibrato: vibrato || undefined,
      breathiness: breathiness || undefined,
      effort: effort || undefined,
      expressiveness: expressiveness || undefined,
    });
    res.json({
      wav: Buffer.from(wav).toString('base64'),
      stream,
      emotion: used,
      totalMs,
      sampleRate: SAMPLE_RATE,
    });
  } catch (err) {
    console.error('/api/speak error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  kLattsch Avatar ready`);
  console.log(`  ->  http://localhost:${PORT}`);
  console.log(`  LLM : ${LLM_MODEL} via ${OLLAMA_URL}`);
  console.log(`  Synth: klattsch (klatts.ch/play engine), emotions: ${EMOTIONS.join(', ')}\n`);
});
