const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const bgMusic = document.getElementById("bgMusic");
const qrBox = document.getElementById("qrBox");
const phoneUrl = document.getElementById("phoneUrl");
const statusText = document.getElementById("statusText");
const timeValue = document.getElementById("timeValue");
const hitValue = document.getElementById("hitValue");
const lifeValue = document.getElementById("lifeValue");
const leaderboardList = document.getElementById("leaderboardList");

const assets = {
  background: loadAsset("/assets/course-space.svg"),
  deer: loadAsset("/assets/deer-rocket.svg"),
  bullet: loadAsset("/assets/course-bullet.svg"),
};

const game = {
  w: 0,
  h: 0,
  stage: { x: 0, y: 0, w: 0, h: 0 },
  sessionId: "",
  maxPlayers: 20,
  stars: [],
  bullets: [],
  effects: [],
  leaderboard: [],
  players: new Map(),
  deer: { x: 240, y: 420, targetX: 240, targetY: 420, nextMoveAt: 0 },
  lastShot: 0,
  nextShotDelay: 520,
  pendingShots: [],
  startTime: performance.now(),
  hits: 0,
};

const audioEngine = {
  context: null,
  master: null,
  started: false,
  musicTimer: null,
  nextNoteTime: 0,
  step: 0,
  nextPulseAt: 0,
};

function loadAsset(src) {
  const img = new Image();
  img.src = src;
  return img;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function startBackgroundAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (audioEngine.started || !AudioContextClass) return;
  let context;
  try {
    context = new AudioContextClass();
  } catch {
    return;
  }
  const master = context.createGain();
  master.gain.value = 0.28;
  master.connect(context.destination);

  const padFilter = context.createBiquadFilter();
  padFilter.type = "lowpass";
  padFilter.frequency.value = 820;
  padFilter.Q.value = 0.7;
  padFilter.connect(master);

  const voices = [
    { frequency: 82.41, type: "sine", gain: 0.045 },
    { frequency: 164.81, type: "triangle", gain: 0.026 },
    { frequency: 246.94, type: "sine", gain: 0.018 },
  ];

  for (const voice of voices) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = voice.type;
    osc.frequency.value = voice.frequency;
    gain.gain.value = voice.gain;
    osc.connect(gain);
    gain.connect(padFilter);
    osc.start();
  }

  audioEngine.context = context;
  audioEngine.master = master;
  audioEngine.started = true;
  audioEngine.nextNoteTime = context.currentTime + 0.08;
  audioEngine.musicTimer = setInterval(scheduleMusic, 100);
}

function tryStartAudio() {
  if (bgMusic) {
    bgMusic.volume = 0.42;
    bgMusic.play().catch(() => {});
  }
  startBackgroundAudio();
  if (audioEngine.context?.state === "suspended") {
    audioEngine.context.resume().then(() => scheduleMusic(true)).catch(() => {});
  } else {
    scheduleMusic(true);
  }
}

function playTone(frequency, startTime, duration, type, peakGain) {
  const context = audioEngine.context;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startTime);
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain);
  gain.connect(audioEngine.master);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.03);
}

function scheduleMusic(force = false) {
  if (!audioEngine.started || !audioEngine.context || audioEngine.context.state !== "running") return;
  const context = audioEngine.context;
  if (force && audioEngine.nextNoteTime < context.currentTime) {
    audioEngine.nextNoteTime = context.currentTime + 0.03;
  }
  const melody = [523.25, 659.25, 783.99, 659.25, 587.33, 739.99, 880, 739.99];
  const bass = [130.81, 130.81, 196, 196, 146.83, 146.83, 220, 220];

  while (audioEngine.nextNoteTime < context.currentTime + 0.65) {
    const step = audioEngine.step % melody.length;
    playTone(melody[step], audioEngine.nextNoteTime, 0.18, "triangle", 0.055);
    if (step % 2 === 0) playTone(bass[step], audioEngine.nextNoteTime, 0.32, "sine", 0.04);
    if (step % 4 === 2) playTone(1046.5, audioEngine.nextNoteTime + 0.09, 0.11, "sine", 0.025);
    audioEngine.step += 1;
    audioEngine.nextNoteTime += 0.32;
  }
}

function playPulseSound(now) {
  if (!audioEngine.started || !audioEngine.context || audioEngine.context.state !== "running" || now < audioEngine.nextPulseAt) return;
  audioEngine.nextPulseAt = now + 1450 + Math.random() * 950;
  playTone(392, audioEngine.context.currentTime, 0.42, "sine", 0.032);
}

function playHitSound(isFinal) {
  if (!audioEngine.started || !audioEngine.context) return;
  const context = audioEngine.context;
  const t = context.currentTime;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = isFinal ? "sawtooth" : "square";
  osc.frequency.setValueAtTime(isFinal ? 120 : 520, t);
  osc.frequency.exponentialRampToValueAtTime(isFinal ? 54 : 260, t + 0.18);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(isFinal ? 0.07 : 0.04, t + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + (isFinal ? 0.38 : 0.16));
  osc.connect(gain);
  gain.connect(audioEngine.master);
  osc.start(t);
  osc.stop(t + (isFinal ? 0.42 : 0.2));
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  game.w = rect.width;
  game.h = rect.height;

  game.stage = {
    x: 0,
    y: 0,
    w: game.w,
    h: game.h,
  };

  game.deer.x = clamp(game.deer.x, game.stage.x + 80, game.stage.x + game.stage.w - 80);
  game.deer.y = clamp(game.deer.y, game.stage.y + game.stage.h - 155, game.stage.y + game.stage.h - 70);
  for (const player of game.players.values()) keepPlayerInside(player);
  makeStars();
}

function makeStars() {
  const count = Math.max(120, Math.floor((game.stage.w * game.stage.h) / 4600));
  game.stars = Array.from({ length: count }, () => ({
    x: game.stage.x + Math.random() * game.stage.w,
    y: game.stage.y + Math.random() * game.stage.h,
    z: 0.3 + Math.random() * 1.8,
    twinkle: Math.random() * Math.PI * 2,
  }));
}

function randomPlayerPosition(index) {
  const s = game.stage;
  const cols = Math.min(5, Math.max(1, game.maxPlayers));
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: s.x + s.w * (0.12 + col * 0.19),
    y: s.y + s.h * (0.18 + (row % 3) * 0.13 + Math.random() * 0.06),
  };
}

function syncPlayer(serverPlayer) {
  const existing = game.players.get(serverPlayer.id);
  const index = Math.max(0, (serverPlayer.slot || 1) - 1);
  const start = randomPlayerPosition(index);
  const player = existing || {
    id: serverPlayer.id,
    x: start.x,
    y: start.y,
    r: 36,
    life: 3,
    invincible: 0,
    hitFlash: 0,
    knockX: 0,
    knockY: 0,
    phase: Math.random() * Math.PI * 2,
    tilt: 0,
    squash: 0,
    trail: [],
    imageElement: null,
    removed: false,
  };

  player.slot = serverPlayer.slot;
  player.name = serverPlayer.name || "";
  player.image = serverPlayer.image || null;
  player.control = serverPlayer.control || { x: 0, y: 0, boost: false };

  if (player.image && (!player.imageElement || player.imageElement.src !== player.image)) {
    const img = new Image();
    img.onload = () => {
      player.imageElement = img;
    };
    img.src = player.image;
  }

  game.players.set(player.id, player);
  keepPlayerInside(player);
  updateStatus();
}

function syncState(state) {
  game.sessionId = state.sessionId || game.sessionId;
  game.maxPlayers = state.maxPlayers || game.maxPlayers;
  game.leaderboard = state.leaderboard || [];
  const ids = new Set((state.players || []).map((player) => player.id));
  for (const id of game.players.keys()) {
    if (!ids.has(id)) game.players.delete(id);
  }
  for (const player of state.players || []) syncPlayer(player);
  renderLeaderboard();
  updateStatus();
}

function renderLeaderboard() {
  if (!leaderboardList) return;
  const entries = (game.leaderboard || []).slice(0, 5);
  if (entries.length === 0) {
    leaderboardList.innerHTML = '<li class="leaderboard-empty">等待挑戰者</li>';
    return;
  }
  leaderboardList.innerHTML = entries.map((entry, index) => {
    const name = escapeHtml(entry.name || "-");
    const seconds = Number(entry.seconds) || 0;
    const activeClass = entry.active ? " is-active" : "";
    return `
      <li class="leaderboard-row${activeClass}">
        <span class="leaderboard-rank">${index + 1}</span>
        <span class="leaderboard-name">${name}</span>
        <span class="leaderboard-time">${seconds}s</span>
      </li>
    `;
  }).join("");
}

function updateStatus() {
  const active = game.players.size;
  if (active === 0) {
    if (statusText) statusText.textContent = "等待加入";
  } else if (active >= game.maxPlayers) {
    if (statusText) statusText.textContent = `${active}/${game.maxPlayers}`;
  } else {
    if (statusText) statusText.textContent = `${active}/${game.maxPlayers}`;
  }
}

async function initQr() {
  const res = await fetch("/api/session");
  const info = await res.json();
  game.sessionId = info.sessionId;
  game.maxPlayers = info.maxPlayers || 20;
  if (!phoneUrl || !qrBox) return;
  phoneUrl.textContent = info.uploadUrl;
  qrBox.textContent = "";
  if (window.QRCode) {
    const qrCanvas = document.createElement("canvas");
    await window.QRCode.toCanvas(qrCanvas, info.uploadUrl, {
      width: 248,
      margin: 1,
      color: { dark: "#06101f", light: "#f8fbff" },
    });
    qrBox.appendChild(qrCanvas);
  } else {
    qrBox.textContent = "請用手機輸入下方網址";
  }
}

function connectEvents() {
  const events = new EventSource("/events");
  events.addEventListener("state", (event) => syncState(JSON.parse(event.data)));
  events.addEventListener("player", (event) => syncPlayer(JSON.parse(event.data)));
  events.addEventListener("control", (event) => {
    const data = JSON.parse(event.data);
    const player = game.players.get(data.playerId);
    if (player) player.control = data.control;
  });
  events.addEventListener("eliminated", (event) => {
    const data = JSON.parse(event.data);
    game.players.delete(data.playerId);
    updateStatus();
  });
  events.addEventListener("batch", (event) => syncState(JSON.parse(event.data)));
}

async function pollState() {
  try {
    const res = await fetch("/api/state");
    if (!res.ok) return;
    syncState(await res.json());
  } catch {
    // EventSource is primary; polling quietly covers unstable network paths.
  }
}

function drawBackground(dt) {
  ctx.fillStyle = "#050813";
  ctx.fillRect(0, 0, game.w, game.h);
  const s = game.stage;

  if (assets.background.complete && assets.background.naturalWidth > 0) {
    ctx.drawImage(assets.background, s.x, s.y, s.w, s.h);
  } else {
    ctx.fillStyle = "#071329";
    ctx.fillRect(s.x, s.y, s.w, s.h);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(s.x, s.y, s.w, s.h);
  ctx.clip();
  for (const star of game.stars) {
    star.y += star.z * dt * 0.038;
    if (star.y > s.y + s.h + 4) {
      star.y = s.y - 4;
      star.x = s.x + Math.random() * s.w;
    }
    const pulse = 0.45 + Math.sin(performance.now() * 0.002 + star.twinkle) * 0.2;
    ctx.globalAlpha = clamp(pulse + star.z * 0.15, 0.25, 1);
    ctx.fillStyle = star.z > 1.4 ? "#ffe7a1" : "#dff8ff";
    ctx.fillRect(star.x, star.y, star.z * 1.6, star.z * 1.6);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function updateDeer(dt, now) {
  const s = game.stage;
  if (now > game.deer.nextMoveAt) {
    game.deer.nextMoveAt = now + 420 + Math.random() * 900;
    game.deer.targetX = s.x + 85 + Math.random() * Math.max(80, s.w - 170);
    game.deer.targetY = s.y + s.h - 165 + Math.random() * 90;
  }
  const ease = 1 - Math.pow(0.982, dt);
  game.deer.x += (game.deer.targetX - game.deer.x) * ease;
  game.deer.y += (game.deer.targetY - game.deer.y) * ease;
}

function keepPlayerInside(player) {
  const s = game.stage;
  player.x = clamp(player.x, s.x + 48, s.x + s.w - 48);
  player.y = clamp(player.y, s.y + 48, s.y + s.h - 190);
}

function fireBullet(x, y, vx = 0, vy = -8.7, scale = 1) {
  game.bullets.push({ x, y, vx, vy, scale });
}

function queueShot(now, delay, fn) {
  game.pendingShots.push({ at: now + delay, fn });
}

function pickNearestPlayer() {
  let nearest = null;
  let distance = Infinity;
  for (const player of game.players.values()) {
    const d = Math.hypot(player.x - game.deer.x, player.y - game.deer.y);
    if (d < distance) {
      nearest = player;
      distance = d;
    }
  }
  return nearest;
}

function fireAimedShot(speed = 8.6) {
  const target = pickNearestPlayer();
  if (!target) {
    fireBullet(game.deer.x, game.deer.y - 48);
    return;
  }
  const dx = target.x - game.deer.x;
  const dy = target.y - (game.deer.y - 48);
  const dist = Math.max(1, Math.hypot(dx, dy));
  fireBullet(game.deer.x, game.deer.y - 48, (dx / dist) * speed, (dy / dist) * speed);
}

function firePattern(now) {
  const active = game.players.size;
  const patterns = active >= 8
    ? ["spread", "burst", "fan", "cross", "aimed"]
    : active >= 3
      ? ["single", "burst", "spread", "fan", "aimed"]
      : ["single", "burst", "aimed", "zigzag"];
  const pattern = patterns[Math.floor(Math.random() * patterns.length)];
  const x = game.deer.x;
  const y = game.deer.y - 48;

  if (pattern === "single") {
    fireBullet(x, y, Math.random() * 1.4 - 0.7, -8.9);
    game.nextShotDelay = 420 + Math.random() * 230;
    return;
  }

  if (pattern === "burst") {
    for (let i = 0; i < 4; i += 1) {
      queueShot(now, i * 86, () => fireBullet(game.deer.x + (Math.random() * 18 - 9), game.deer.y - 48, Math.random() * 1.2 - 0.6, -9.4, 0.9));
    }
    game.nextShotDelay = 760 + Math.random() * 260;
    return;
  }

  if (pattern === "spread") {
    const count = active >= 10 ? 7 : 5;
    const mid = (count - 1) / 2;
    for (let i = 0; i < count; i += 1) {
      const vx = (i - mid) * 1.25;
      fireBullet(x + (i - mid) * 9, y, vx, -8.4, 0.88);
    }
    game.nextShotDelay = 820 + Math.random() * 320;
    return;
  }

  if (pattern === "fan") {
    for (let i = 0; i < 3; i += 1) {
      queueShot(now, i * 140, () => {
        for (const vx of [-2.4, -1.2, 0, 1.2, 2.4]) {
          fireBullet(game.deer.x, game.deer.y - 48, vx, -8.2, 0.82);
        }
      });
    }
    game.nextShotDelay = 1050 + Math.random() * 350;
    return;
  }

  if (pattern === "cross") {
    for (const vx of [-3.2, -1.6, 0, 1.6, 3.2]) fireBullet(x, y, vx, -8.1, 0.85);
    queueShot(now, 180, () => {
      for (const offset of [-48, -24, 24, 48]) fireBullet(game.deer.x + offset, game.deer.y - 48, -offset * 0.035, -8.8, 0.85);
    });
    game.nextShotDelay = 980 + Math.random() * 320;
    return;
  }

  if (pattern === "zigzag") {
    for (let i = 0; i < 6; i += 1) {
      queueShot(now, i * 95, () => {
        const dir = i % 2 === 0 ? -1 : 1;
        fireBullet(game.deer.x + dir * 18, game.deer.y - 48, dir * 1.9, -8.7, 0.9);
      });
    }
    game.nextShotDelay = 900 + Math.random() * 280;
    return;
  }

  fireAimedShot(8.8);
  queueShot(now, 130, () => fireAimedShot(9.1));
  game.nextShotDelay = 760 + Math.random() * 280;
}

function update(dt, now) {
  updateDeer(dt, now);
  playPulseSound(now);

  for (const shot of game.pendingShots) {
    if (!shot.done && now >= shot.at) {
      shot.done = true;
      shot.fn();
    }
  }
  game.pendingShots = game.pendingShots.filter((shot) => !shot.done);

  if (now - game.lastShot > game.nextShotDelay) {
    game.lastShot = now;
    firePattern(now);
  }

  for (const player of game.players.values()) {
    const prevX = player.x;
    const prevY = player.y;
    const speed = (player.control?.boost ? 10.8 : 7.1) * (dt / 16.67);
    player.x += (player.control?.x || 0) * speed + player.knockX * (dt / 16.67);
    player.y += (player.control?.y || 0) * speed + player.knockY * (dt / 16.67);
    player.knockX *= Math.pow(0.86, dt / 16.67);
    player.knockY *= Math.pow(0.86, dt / 16.67);
    player.invincible = Math.max(0, player.invincible - dt);
    player.hitFlash = Math.max(0, player.hitFlash - dt);
    player.phase += dt * 0.0048;
    player.tilt += (((player.control?.x || 0) * 0.2) - player.tilt) * 0.12;
    const movement = Math.hypot(player.x - prevX, player.y - prevY);
    player.squash += (clamp(movement / 22, 0, 0.18) - player.squash) * 0.18;
    for (const trail of player.trail) trail.age += dt;
    player.trail = player.trail.filter((trail) => trail.age < trail.life);
    if (movement > 0.8 && player.imageElement && player.trail.length < 7) {
      player.trail.unshift({ x: prevX, y: prevY, age: 0, life: 280 });
    }
    keepPlayerInside(player);
  }

  for (const bullet of game.bullets) {
    bullet.x += (bullet.vx || 0) * (dt / 16.67);
    bullet.y += bullet.vy * (dt / 16.67);
  }
  game.bullets = game.bullets.filter((bullet) => (
    bullet.y > game.stage.y - 40 &&
    bullet.x > game.stage.x - 60 &&
    bullet.x < game.stage.x + game.stage.w + 60
  ));

  for (const bullet of game.bullets) {
    for (const player of game.players.values()) {
      if (player.removed || player.invincible > 0) continue;
      if (Math.hypot(bullet.x - player.x, bullet.y - player.y) < player.r * 0.82) {
        bullet.y = game.stage.y - 100;
        player.life -= 1;
        player.hitFlash = 240;
        player.invincible = 380;
        player.knockX += clamp((player.x - bullet.x) * 0.28, -7, 7);
        player.knockY -= 5.5;
        game.hits += 1;
        addHitEffect(player.x, player.y, player.life <= 0);
        if (player.life <= 0) eliminatePlayer(player);
        break;
      }
    }
  }

  for (const effect of game.effects) effect.age += dt;
  game.effects = game.effects.filter((effect) => effect.age < effect.life);
}

function eliminatePlayer(player) {
  player.removed = true;
  game.players.delete(player.id);
  updateStatus();
  fetch("/api/eliminate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: game.sessionId, playerId: player.id }),
  }).catch(() => {});
}

function addHitEffect(x, y, isFinal) {
  playHitSound(isFinal);
  const count = isFinal ? 28 : 14;
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (isFinal ? 3.5 : 2.2) + Math.random() * (isFinal ? 5 : 3);
    game.effects.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      age: 0,
      life: isFinal ? 620 + Math.random() * 260 : 340 + Math.random() * 180,
      size: (isFinal ? 4 : 3) + Math.random() * 5,
      color: Math.random() > 0.45 ? "#ffd166" : "#ff6178",
    });
  }
}

function drawBullets() {
  for (const bullet of game.bullets) {
    if (assets.bullet.complete && assets.bullet.naturalWidth > 0) {
      ctx.save();
      ctx.translate(bullet.x, bullet.y);
      ctx.rotate(Math.atan2(bullet.vy, bullet.vx || 0));
      const scale = bullet.scale || 1;
      ctx.drawImage(assets.bullet, -11 * scale, -19 * scale, 22 * scale, 38 * scale);
      ctx.restore();
    } else {
      ctx.fillStyle = "#ffd166";
      ctx.fillRect(bullet.x - 2, bullet.y - 14, 4, 20);
    }
  }
}

function drawDeerShip(x, y, now) {
  if (!assets.deer.complete || assets.deer.naturalWidth <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.sin(now * 0.004) * 0.08);
  ctx.drawImage(assets.deer, -62, -58, 124, 116);
  ctx.restore();
}

function drawPlayer(player) {
  const floatY = Math.sin(player.phase) * 5;
  if (player.imageElement) {
    const size = player.r * 2.1;
    for (let i = player.trail.length - 1; i >= 0; i -= 1) {
      const trail = player.trail[i];
      const t = trail.age / trail.life;
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.2;
      ctx.translate(trail.x, trail.y + floatY * 0.4);
      ctx.rotate(player.tilt * 0.65);
      ctx.scale(1 + player.squash * 0.4, 1 - player.squash * 0.25);
      ctx.drawImage(player.imageElement, -size / 2, -size / 2, size, size);
      ctx.restore();
    }
  }

  ctx.save();
  const shake = player.hitFlash > 0 ? Math.sin(performance.now() * 0.09) * 5 : 0;
  ctx.translate(player.x + shake, player.y + floatY);
  ctx.rotate(player.tilt + Math.sin(player.phase * 1.7) * 0.035);
  ctx.scale(1 + player.squash, 1 - player.squash * 0.45);
  if (player.invincible > 0) ctx.globalAlpha = 0.72 + Math.sin(performance.now() * 0.07) * 0.18;
  if (player.imageElement) {
    const size = player.r * 2.1;
    ctx.drawImage(player.imageElement, -size / 2, -size / 2, size, size);
  } else {
    ctx.fillStyle = ["#6ee7a8", "#65d6ff", "#ffd166", "#ff8aa0", "#bda4ff"][player.slot % 5];
    ctx.beginPath();
    ctx.arc(0, 0, player.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#050813";
    ctx.beginPath();
    ctx.arc(-13, -7, 6, 0, Math.PI * 2);
    ctx.arc(13, -7, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  if (player.hitFlash > 0) {
    ctx.globalAlpha = Math.min(0.85, player.hitFlash / 240);
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(0, 0, player.r * 1.15, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.fillStyle = "rgba(5, 8, 19, 0.62)";
  ctx.fillRect(player.x - 38, player.y + player.r + 13, 76, 8);
  ctx.fillStyle = player.life > 1 ? "#6ee7a8" : "#ff6178";
  ctx.fillRect(player.x - 38, player.y + player.r + 13, 76 * (player.life / 3), 8);
  if (player.name) {
    ctx.fillStyle = "#f8fbff";
    ctx.textAlign = "center";
    ctx.font = "13px Microsoft JhengHei, sans-serif";
    ctx.fillText(player.name, player.x, player.y - player.r - 10);
  }
}

function drawEffects(dt) {
  for (const effect of game.effects) {
    const t = effect.age / effect.life;
    effect.x += effect.vx * (dt / 16.67);
    effect.y += effect.vy * (dt / 16.67);
    effect.vy += 0.08 * (dt / 16.67);
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = effect.color;
    ctx.beginPath();
    ctx.arc(effect.x, effect.y, effect.size * (1 - t * 0.35), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawOverlay() {
  return;
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(34, now - last);
  last = now;
  update(dt, now);
  drawBackground(dt);
  drawBullets();
  for (const player of game.players.values()) {
    if (!player.removed) drawPlayer(player);
  }
  drawEffects(dt);
  drawDeerShip(game.deer.x, game.deer.y, now);
  drawOverlay();

  timeValue.textContent = Math.floor((now - game.startTime) / 1000);
  hitValue.textContent = game.hits;
  lifeValue.textContent = `${game.players.size}/${game.maxPlayers}`;
  requestAnimationFrame(loop);
}

function setNearestPlayerFromPointer(event) {
  if (game.players.size === 0) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let nearest = null;
  let distance = Infinity;
  for (const player of game.players.values()) {
    const d = Math.hypot(player.x - x, player.y - y);
    if (d < distance) {
      nearest = player;
      distance = d;
    }
  }
  if (nearest) {
    nearest.x = x;
    nearest.y = y;
    keepPlayerInside(nearest);
  }
}

canvas.addEventListener("pointerdown", (event) => {
  tryStartAudio();
  canvas.setPointerCapture(event.pointerId);
  setNearestPlayerFromPointer(event);
});
canvas.addEventListener("pointermove", (event) => {
  if (event.buttons) setNearestPlayerFromPointer(event);
});

window.addEventListener("resize", resize);
window.addEventListener("click", tryStartAudio);
window.addEventListener("touchstart", tryStartAudio, { passive: true });
window.addEventListener("keydown", tryStartAudio);
resize();
tryStartAudio();
initQr().catch(() => {
  if (qrBox) qrBox.textContent = "QR code 載入失敗，請確認伺服器網址";
});
connectEvents();
setInterval(pollState, 140);
requestAnimationFrame(loop);
