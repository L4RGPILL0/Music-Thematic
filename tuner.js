'use strict';

const INSTRUMENTS = {
  basse: {
    label: 'Basse',
    lowpass: 320,
    strings: [
      { name: 'E', freq: 41.20 },
      { name: 'A', freq: 55.00 },
      { name: 'D', freq: 73.42 },
      { name: 'G', freq: 98.00 },
    ],
  },
  guitare: {
    label: 'Guitare',
    lowpass: 1400,
    strings: [
      { name: 'E', freq: 82.41 },
      { name: 'A', freq: 110.00 },
      { name: 'D', freq: 146.83 },
      { name: 'G', freq: 196.00 },
      { name: 'B', freq: 246.94 },
      { name: 'E', freq: 329.63 },
    ],
  },
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const A4 = 440;
const MIN_FREQ = 30;
const MAX_FREQ = 420;
const BUFFER_SIZE = 4096;

let selectedInst = 'basse';
let audioCtx = null;
let analyser = null;
let lowpass = null;
let stream = null;
let rafId = null;
let running = false;
let toneOsc = null;
let smoothCents = null;

const $ = (id) => document.getElementById(id);
const buf = new Float32Array(BUFFER_SIZE);

function yinDetect(buf, sampleRate) {
  const tauMax = Math.floor(sampleRate / MIN_FREQ);
  const tauMin = Math.floor(sampleRate / MAX_FREQ);
  const yinBuffer = new Float32Array(tauMax);

  for (let tau = 0; tau < tauMax; tau++) {
    let sum = 0;
    const limit = Math.min(buf.length - tau, buf.length / 2);
    for (let i = 0; i < limit; i++) {
      const d = buf[i] - buf[i + tau];
      sum += d * d;
    }
    yinBuffer[tau] = sum;
  }

  yinBuffer[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < tauMax; tau++) {
    runningSum += yinBuffer[tau];
    yinBuffer[tau] *= tau / (runningSum || 1);
  }

  const threshold = 0.12;
  let tauEstimate = -1;
  for (let tau = tauMin; tau < tauMax; tau++) {
    if (yinBuffer[tau] < threshold) {
      while (tau + 1 < tauMax && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate === -1) return -1;

  const x0 = tauEstimate > 0 ? tauEstimate - 1 : 0;
  const x2 = tauEstimate + 1 < tauMax ? tauEstimate + 1 : tauEstimate;
  if (x2 === tauEstimate || x0 === tauEstimate) return sampleRate / tauEstimate;
  const s0 = yinBuffer[x0];
  const s1 = yinBuffer[tauEstimate];
  const s2 = yinBuffer[x2];
  const denom = 2 * (2 * s1 - s2 - s0);
  if (denom === 0) return sampleRate / tauEstimate;
  const betterTau = tauEstimate + (s2 - s0) / denom;
  return sampleRate / betterTau;
}

function freqToNoteInfo(freq) {
  const midi = 69 + 12 * Math.log2(freq / A4);
  const rounded = Math.round(midi);
  const cents = (midi - rounded) * 100;
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return { name, octave, cents };
}

function nearestString(freq) {
  const strings = INSTRUMENTS[selectedInst].strings;
  let best = null;
  let bestDiff = Infinity;
  for (const s of strings) {
    const cents = 1200 * Math.log2(freq / s.freq);
    if (Math.abs(cents) < Math.abs(bestDiff)) { bestDiff = cents; best = s; }
  }
  return { str: best, cents: bestDiff };
}

function setNeedle(cents, idle) {
  const angle = idle ? 0 : (cents / 50) * 84;
  $('needle').style.transform = `rotate(${angle}deg)`;
}

function renderStrings() {
  const strings = INSTRUMENTS[selectedInst].strings;
  $('strings').innerHTML = strings.map((s) =>
    `<div class="str" data-f="${s.freq.toFixed(2)}"><div class="n">${s.name}</div><div class="f">${s.freq.toFixed(1)} Hz</div></div>`
  ).join('');
  $('inst-label').textContent = INSTRUMENTS[selectedInst].label;
}

function update() {
  rafId = requestAnimationFrame(update);
  analyser.getFloatTimeDomainData(buf);

  const freq = yinDetect(buf, audioCtx.sampleRate);

  if (freq < MIN_FREQ || freq > MAX_FREQ) {
    $('note').textContent = '–';
    $('octave').textContent = '';
    $('freq').textContent = '– Hz';
    $('status').textContent = '';
    $('status').style.color = '';
    setNeedle(0, true);
    document.querySelectorAll('.str').forEach(el => el.classList.remove('active', 'done'));
    return;
  }

  const info = freqToNoteInfo(freq);
  const near = nearestString(freq);
  const inTune = Math.abs(near.cents) < 5;

  $('note').textContent = info.name;
  $('octave').textContent = info.octave;
  $('freq').textContent = freq.toFixed(1) + ' Hz';

  const targetCents = Math.max(-50, Math.min(50, near.cents));
  smoothCents = smoothCents === null ? targetCents : smoothCents * 0.6 + targetCents * 0.4;
  setNeedle(smoothCents, false);

  const status = $('status');
  if (inTune) {
    status.textContent = '✓ Accordé';
    status.style.color = 'var(--in-tune)';
  } else if (near.cents < 0) {
    status.textContent = '♭ Trop bas — serrez la mécanique';
    status.style.color = 'var(--flat)';
  } else {
    status.textContent = '♯ Trop haut — desserrez la mécanique';
    status.style.color = 'var(--sharp)';
  }

  const targetF = near.str.freq.toFixed(2);
  document.querySelectorAll('.str').forEach(el => {
    const isTarget = el.dataset.f === targetF;
    el.classList.toggle('active', isTarget && !inTune);
    el.classList.toggle('done', isTarget && inTune);
  });
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('show'));
  $(id).classList.add('show');
}

function goHome() {
  stopTuner();
  showView('home');
}

window.addEventListener('popstate', (e) => {
  if ($('tuner').classList.contains('show')) goHome();
});
}

async function startTuner() {
  $('err').style.display = 'none';
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    $('err').textContent = 'Accès au micro refusé. Autorisez le micro dans Réglages > Safari.';
    $('err').style.display = 'block';
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();

  const sourceNode = audioCtx.createMediaStreamSource(stream);
  lowpass = audioCtx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = INSTRUMENTS[selectedInst].lowpass;
  lowpass.Q.value = 0.7;
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = BUFFER_SIZE;

  sourceNode.connect(lowpass);
  lowpass.connect(analyser);

  running = true;
  smoothCents = null;
  renderStrings();
  showView('tuner');
  update();
}

function stopTuner() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (toneOsc) { toneOsc.stop(); toneOsc = null; $('toneBtn').classList.remove('on'); }
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();
  audioCtx = null;
  stream = null;
}

function toggleTone() {
  if (!audioCtx) return;
  if (toneOsc) {
    toneOsc.stop();
    toneOsc = null;
    $('toneBtn').classList.remove('on');
    return;
  }
  const active = document.querySelector('.str.active, .str.done');
  const freq = active ? parseFloat(active.dataset.f) : INSTRUMENTS[selectedInst].strings[0].freq;
  toneOsc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  toneOsc.frequency.value = freq;
  toneOsc.type = 'triangle';
  gain.gain.value = 0.25;
  toneOsc.connect(gain);
  gain.connect(audioCtx.destination);
  toneOsc.start();
  $('toneBtn').classList.add('on');
}

document.querySelectorAll('.inst').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.inst').forEach(i => i.classList.remove('selected'));
    el.classList.add('selected');
    selectedInst = el.dataset.inst;
    const btn = $('startBtn');
    btn.disabled = false;
    btn.textContent = `Accorder ma ${INSTRUMENTS[selectedInst].label.toLowerCase()}`;
  });
});

$('startBtn').addEventListener('click', startTuner);
$('backBtn').addEventListener('click', () => { stopTuner(); showView('home'); });
$('stopBtn').addEventListener('click', () => { stopTuner(); showView('home'); });
$('toneBtn').addEventListener('click', toggleTone);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
