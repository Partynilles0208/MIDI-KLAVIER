// ================= DOM =================
const midiInput = document.getElementById("midiInput");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const stopBtn = document.getElementById("stopBtn");
const speedInput = document.getElementById("speed");
const speedValue = document.getElementById("speedValue");
const volumeInput = document.getElementById("volume");
const barsEl = document.getElementById("bars");
const keyboardEl = document.getElementById("keyboard");
const rollEl = document.getElementById("roll");
const fileNameEl = document.getElementById("fileName");
const timeReadoutEl = document.getElementById("timeReadout");

// ================= AUDIO (Compressor -> MasterGain) =================
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

const compressor = audioCtx.createDynamicsCompressor();
compressor.threshold.value = -18;
compressor.knee.value = 24;
compressor.ratio.value = 6;
compressor.attack.value = 0.003;
compressor.release.value = 0.25;

const masterGain = audioCtx.createGain();
masterGain.gain.value = 1;

compressor.connect(masterGain).connect(audioCtx.destination);

let piano = null;
const activePlayers = new Set();

async function ensurePianoLoaded() {
  if (piano) return piano;

  const SF = window.Soundfont || window.SoundfontPlayer;
  if (!SF || !SF.instrument) {
    throw new Error(
      "Soundfont-Player nicht gefunden. Prüfe: soundfont-player.js im Ordner UND in index.html vor script.js eingebunden."
    );
  }

  piano = await SF.instrument(audioCtx, "acoustic_grand_piano", {
    destination: compressor,
  });

  return piano;
}

function stopAllPlayers() {
  for (const p of activePlayers) {
    try { p.stop(); } catch {}
  }
  activePlayers.clear();
}

// ================= 88-TASTEN-KLANGCHARAKTER =================
function playNoteSample(note, durationSec, velocity, whenCtxTime) {
  if (!piano) return;

  const notePos = (note - 21) / 87;

  const vel = Math.max(0.04, Math.min(1, Math.pow((velocity ?? 90) / 127, 1.9)));
  const gainComp = 0.75 + (1 - notePos) * 0.45;

  const releaseBoost = 0.9 + (1 - notePos) * 0.8;
  const finalDuration = Math.max(0.06, durationSec * releaseBoost);

  const panValue = (notePos - 0.5) * 0.9;

  const player = piano.play(note, whenCtxTime, {
    gain: vel * gainComp,
    duration: finalDuration,
  });

  const panner = audioCtx.createStereoPanner();
  panner.pan.setValueAtTime(panValue, whenCtxTime);

  if (player && player.output) {
    try {
      player.output.disconnect();
      player.output.connect(panner).connect(compressor);
    } catch {
      try { player.output.connect(panner).connect(compressor); } catch {}
    }
  }

  activePlayers.add(player);
  setTimeout(() => activePlayers.delete(player), (finalDuration + 1) * 1000);
}

// ================= VISUAL / STATE =================
const BLACK_NOTES = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

const state = {
  notes: [],
  bars: [],
  keyMap: new Map(), // note -> {element,width,left}

  startEvents: [],
  playState: "stopped",
  speed: 1,
  startStamp: 0,
  pauseOffset: 0,

  animationId: null,
  barPixelsPerSecond: 180,
  keyLine: 0,

  // Scheduler
  scheduleTimer: null,
  lookaheadMs: 25,
  scheduleAheadTime: 0.25,
  nextScheduleIndex: 0,
  audioStartCtxTime: 0,

  totalDuration: 0,

  // Key active by time (robust polyphony)
  activeCount: new Map(), // note -> count
};

function formatNoteName(note) {
  const name = NOTE_NAMES[note % 12];
  const octave = Math.floor(note / 12) - 1;
  return `${name}${octave}`;
}

function clearStage() {
  barsEl.innerHTML = "";
  keyboardEl.innerHTML = "";
  state.keyMap.clear();
  state.bars = [];
  state.notes = [];
  state.startEvents = [];
  state.nextScheduleIndex = 0;
  state.totalDuration = 0;
  state.activeCount.clear();
  stopAllPlayers();
}

function buildKeyboard() {
  const whiteKeyWidth = 22;
  const blackKeyWidth = 14;
  let whiteIndex = 0;

  for (let note = 21; note <= 108; note++) {
    const isBlack = BLACK_NOTES.has(note % 12);
    const key = document.createElement("div");
    key.className = `key ${isBlack ? "black" : "white"}`;

    const keyWidth = isBlack ? blackKeyWidth : whiteKeyWidth;
    let left;

    if (isBlack) {
      left = whiteIndex * whiteKeyWidth - keyWidth / 2;
      key.style.width = `${keyWidth}px`;
      key.style.left = `${left}px`;
    } else {
      left = whiteIndex * whiteKeyWidth;
      key.style.width = `${keyWidth}px`;
      key.style.left = `${left}px`;
      key.textContent = formatNoteName(note);
      whiteIndex++;
    }

    keyboardEl.appendChild(key);
    state.keyMap.set(note, { element: key, width: keyWidth, left });
  }

  keyboardEl.style.width = `${whiteIndex * whiteKeyWidth}px`;
  rollEl.style.width = keyboardEl.style.width;
  state.keyLine = rollEl.clientHeight;
}

function createBar(note, start, end) {
  const keyInfo = state.keyMap.get(note);
  if (!keyInfo) return null;

  const bar = document.createElement("div");
  const height = Math.max((end - start) * state.barPixelsPerSecond, 8);

  bar.className = "bar";
  bar.style.left = `${keyInfo.left + 1}px`;
  bar.style.width = `${Math.max(keyInfo.width - 2, 6)}px`;
  bar.style.height = `${height}px`;

  const hue = (note * 3.2) % 360;
  bar.style.background = `linear-gradient(180deg, hsla(${hue}, 82%, 70%, 0.9), hsla(${hue}, 70%, 45%, 0.9))`;

  barsEl.appendChild(bar);
  return { element: bar, note, start, end, height };
}

function updateBars(playTime) {
  for (const bar of state.bars) {
    const top = state.keyLine - bar.height - (bar.start - playTime) * state.barPixelsPerSecond;
    bar.element.style.transform = `translateY(${top}px)`;
    bar._top = top; // cache für collision-check
  }
}

// ================= KEY HIGHLIGHTING (Bars berühren Keyline) =================
function setKeyActive(note, isActive) {
  const info = state.keyMap.get(note);
  if (!info) return;
  info.element.classList.toggle("active", !!isActive);
}

// Wir aktivieren Tasten, wenn das Bar-Rechteck die Keyline überlappt:
// Bar reicht von top..top+height
// Keyline ist bei y = state.keyLine (unten im roll)
function updateKeyHighlights() {
  const lineY = state.keyLine;
  const eps = 1; // kleine Toleranz

  // Zähler zurücksetzen
  state.activeCount.clear();

  for (const bar of state.bars) {
    const top = bar._top ?? 0;
    const bottom = top + bar.height;

    const touching = (top <= lineY + eps) && (bottom >= lineY - eps);
    if (touching) {
      state.activeCount.set(bar.note, (state.activeCount.get(bar.note) || 0) + 1);
    }
  }

  // Alle Keys setzen
  for (const [note, info] of state.keyMap.entries()) {
    setKeyActive(note, (state.activeCount.get(note) || 0) > 0);
  }
}

// ================= Scheduler =================
function scheduleNotes() {
  if (state.playState !== "playing") return;

  const nowCtx = audioCtx.currentTime;
  const playTimeNow = ((performance.now() - state.startStamp) / 1000) * state.speed;
  const windowEnd = playTimeNow + state.scheduleAheadTime * state.speed;

  while (
    state.nextScheduleIndex < state.startEvents.length &&
    state.startEvents[state.nextScheduleIndex].time <= windowEnd
  ) {
    const ev = state.startEvents[state.nextScheduleIndex];
    const durSong = Math.max(ev.end - ev.time, 0.05);

    const whenCtx = state.audioStartCtxTime + ev.time / state.speed;
    const durCtx = durSong / state.speed;

    playNoteSample(ev.note, durCtx, ev.velocity, Math.max(whenCtx, nowCtx + 0.008));
    state.nextScheduleIndex++;
  }
}

function tick() {
  if (state.playState !== "playing") return;

  const t = ((performance.now() - state.startStamp) / 1000) * state.speed;
  timeReadoutEl.textContent = `${t.toFixed(1)}s`;

  updateBars(t);
  updateKeyHighlights(); // ✅ HIER kommt das neue Feature

  if (state.nextScheduleIndex >= state.startEvents.length && t > state.totalDuration + 1) {
    stopPlayback();
    return;
  }

  state.animationId = requestAnimationFrame(tick);
}

// ================= Controls =================
async function startPlayback() {
  if (!state.notes.length) {
    fileNameEl.textContent = `${fileNameEl.textContent} (0 Noten erkannt!)`;
    return;
  }

  if (audioCtx.state === "suspended") await audioCtx.resume();
  await ensurePianoLoaded();

  state.playState = "playing";
  state.startStamp = performance.now() - (state.pauseOffset / state.speed) * 1000;
  state.audioStartCtxTime = audioCtx.currentTime - (state.pauseOffset / state.speed);

  state.nextScheduleIndex = state.startEvents.findIndex((e) => e.time >= state.pauseOffset);
  if (state.nextScheduleIndex < 0) state.nextScheduleIndex = state.startEvents.length;

  playBtn.disabled = true;
  pauseBtn.disabled = false;
  stopBtn.disabled = false;

  if (state.scheduleTimer) clearInterval(state.scheduleTimer);
  state.scheduleTimer = setInterval(scheduleNotes, state.lookaheadMs);
  scheduleNotes();

  if (state.animationId) cancelAnimationFrame(state.animationId);
  state.animationId = requestAnimationFrame(tick);
}

function pausePlayback() {
  if (state.playState !== "playing") return;

  state.playState = "paused";
  state.pauseOffset = ((performance.now() - state.startStamp) / 1000) * state.speed;

  playBtn.disabled = false;
  pauseBtn.disabled = true;
  stopBtn.disabled = false;

  if (state.animationId) cancelAnimationFrame(state.animationId);
  state.animationId = null;

  if (state.scheduleTimer) clearInterval(state.scheduleTimer);
  state.scheduleTimer = null;

  stopAllPlayers();
}

function stopPlayback() {
  state.playState = "stopped";
  state.pauseOffset = 0;
  timeReadoutEl.textContent = "0.0s";

  if (state.animationId) cancelAnimationFrame(state.animationId);
  state.animationId = null;

  if (state.scheduleTimer) clearInterval(state.scheduleTimer);
  state.scheduleTimer = null;

  stopAllPlayers();
  updateBars(0);
  updateKeyHighlights(); // reset keys

  playBtn.disabled = state.notes.length === 0;
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
}

// ================= MIDI PARSER =================
function parseMidi(arrayBuffer) {
  const data = new DataView(arrayBuffer);
  let offset = 0;

  function readUint32() { const v = data.getUint32(offset); offset += 4; return v; }
  function readUint16() { const v = data.getUint16(offset); offset += 2; return v; }
  function readUint8() { const v = data.getUint8(offset); offset += 1; return v; }

  function readVarInt() {
    let value = 0;
    while (true) {
      const byte = readUint8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  }

  function readString(length) {
    let str = "";
    for (let i = 0; i < length; i++) str += String.fromCharCode(readUint8());
    return str;
  }

  const header = readString(4);
  if (header !== "MThd") throw new Error("Invalid MIDI file (no MThd)");

  const headerLength = readUint32();
  readUint16(); // format
  const trackCount = readUint16();
  const division = readUint16();
  offset += headerLength - 6;

  const tempoChanges = [{ tick: 0, mpqn: 500000 }];
  const notes = [];

  for (let track = 0; track < trackCount; track++) {
    const trackHeader = readString(4);
    if (trackHeader !== "MTrk") throw new Error("Invalid MIDI track header");

    const trackLength = readUint32();
    const trackEnd = offset + trackLength;

    let tick = 0;
    let runningStatus = null;
    const noteOn = new Map();

    while (offset < trackEnd) {
      tick += readVarInt();

      let statusByte = readUint8();
      if (statusByte < 0x80) {
        if (runningStatus === null) throw new Error("Running status without previous status");
        offset -= 1;
        statusByte = runningStatus;
      } else {
        runningStatus = statusByte;
      }

      if (statusByte === 0xff) {
        const type = readUint8();
        const length = readVarInt();
        if (type === 0x51 && length === 3) {
          const mpqn = (readUint8() << 16) | (readUint8() << 8) | readUint8();
          tempoChanges.push({ tick, mpqn });
        } else {
          offset += length;
        }
        continue;
      }

      if (statusByte === 0xf0 || statusByte === 0xf7) {
        offset += readVarInt();
        continue;
      }

      const eventType = statusByte & 0xf0;
      const hasTwoData = eventType !== 0xc0 && eventType !== 0xd0;
      const data1 = readUint8();
      const data2 = hasTwoData ? readUint8() : 0;

      if (eventType === 0x90 && data2 > 0) {
        const list = noteOn.get(data1) || [];
        list.push({ tick, velocity: data2 });
        noteOn.set(data1, list);
      } else if (eventType === 0x80 || (eventType === 0x90 && data2 === 0)) {
        const list = noteOn.get(data1);
        if (list && list.length) {
          const start = list.shift();
          notes.push({ note: data1, startTick: start.tick, endTick: tick, velocity: start.velocity });
        }
      }
    }

    offset = trackEnd;
  }

  tempoChanges.sort((a, b) => a.tick - b.tick);

  function ticksToSeconds(tick) {
    let time = 0;
    let lastTick = tempoChanges[0].tick;
    let lastTempo = tempoChanges[0].mpqn;

    for (let i = 1; i < tempoChanges.length; i++) {
      const change = tempoChanges[i];
      if (change.tick >= tick) break;
      time += ((change.tick - lastTick) * lastTempo) / 1000000 / division;
      lastTick = change.tick;
      lastTempo = change.mpqn;
    }

    time += ((tick - lastTick) * lastTempo) / 1000000 / division;
    return time;
  }

  return notes
    .filter((n) => n.note >= 21 && n.note <= 108)
    .map((n) => ({
      note: n.note,
      start: ticksToSeconds(n.startTick),
      end: ticksToSeconds(n.endTick),
      velocity: n.velocity || 90,
    }))
    .sort((a, b) => a.start - b.start);
}

// ================= Load MIDI =================
function loadMidi(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      stopPlayback();
      clearStage();
      buildKeyboard();

      const notes = parseMidi(reader.result);
      state.notes = notes;

      state.startEvents = notes.map((n) => ({
        time: n.start,
        note: n.note,
        end: n.end,
        velocity: n.velocity,
      })).sort((a, b) => a.time - b.time);

      barsEl.innerHTML = "";
      state.bars = [];
      for (const n of notes) {
        const bar = createBar(n.note, n.start, n.end);
        if (bar) state.bars.push(bar);
      }
      updateBars(0);
      updateKeyHighlights();

      state.totalDuration = notes.length ? notes[notes.length - 1].end : 0;

      fileNameEl.textContent = `${file.name} geladen: ${notes.length} Noten.`;
      playBtn.disabled = notes.length === 0;
      pauseBtn.disabled = true;
      stopBtn.disabled = true;

      if (notes.length === 0) {
        fileNameEl.textContent += " (MIDI enthält keine Piano-Noten oder ist Drum-only)";
      }
    } catch (err) {
      console.error(err);
      fileNameEl.textContent = "Fehler beim Laden/Parsen der MIDI.";
      playBtn.disabled = true;
    }
  };
  reader.readAsArrayBuffer(file);
}

// ================= UI EVENTS =================
midiInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  loadMidi(file);
});

playBtn.addEventListener("click", () => startPlayback());
pauseBtn.addEventListener("click", () => pausePlayback());
stopBtn.addEventListener("click", () => stopPlayback());

speedInput.addEventListener("input", () => {
  state.speed = Number(speedInput.value);
  speedValue.textContent = `${state.speed.toFixed(1)}x`;
});

volumeInput.addEventListener("input", () => {
  const v = Number(volumeInput.value);
  const value = Number.isFinite(v) ? v : 1;

  const now = audioCtx.currentTime;
  masterGain.gain.cancelScheduledValues(now);
  masterGain.gain.setValueAtTime(masterGain.gain.value, now);
  masterGain.gain.linearRampToValueAtTime(Math.max(0, value), now + 0.05);
});

// ================= INIT =================
buildKeyboard();
updateBars(0);
updateKeyHighlights();

playBtn.disabled = true;
pauseBtn.disabled = true;
stopBtn.disabled = true;

speedValue.textContent = `${Number(speedInput.value).toFixed(1)}x`;
volumeInput.value = "1";
