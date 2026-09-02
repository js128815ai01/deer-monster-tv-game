const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 3128);
const UPLOAD_LIMIT = Number(process.env.UPLOAD_LIMIT || 24 * 1024 * 1024);
const PUBLIC_DIR = path.join(__dirname, "public");
const VENV_PYTHON = path.join(__dirname, ".venv", "Scripts", "python.exe");
const PYTHON_BIN = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python";
const MODEL_DIR = path.join(__dirname, "models");
const sessionId = crypto.randomBytes(4).toString("hex");
const clients = new Set();
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 20);
const BG_REMOVE_TIMEOUT_MS = Number(process.env.BG_REMOVE_TIMEOUT_MS || 45000);
const HEURISTIC_TIMEOUT_MS = Number(process.env.HEURISTIC_TIMEOUT_MS || 9000);
const imageProcessingQueue = [];
let imageProcessingRunning = false;

const state = {
  sessionId,
  batch: 1,
  players: [],
  queue: [],
  drafts: [],
  leaderboard: [],
  eliminatedIds: new Set(),
};

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const items of Object.values(nets)) {
    for (const net of items || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0";
}

function requestBaseUrl(req) {
  const requestHost = String(req.headers.host || "");
  const hostname = requestHost.split(":")[0];
  if (requestHost && !isLocalHost(hostname)) {
    const proto = req.headers["x-forwarded-proto"] || "http";
    return `${proto}://${requestHost}`;
  }
  return `http://${getLanIp()}:${PORT}`;
}

function sendJson(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function broadcast(type, payload = {}) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(message);
}

function publicState() {
  return {
    sessionId: state.sessionId,
    batch: state.batch,
    maxPlayers: MAX_PLAYERS,
    players: state.players,
    queueCount: state.queue.length,
    leaderboard: leaderboardEntries(),
  };
}

function makePlayer() {
  return {
    id: crypto.randomBytes(6).toString("hex"),
    slot: null,
    batch: state.batch,
    status: "draft",
    name: "",
    image: null,
    imageVersion: 0,
    uploadedAt: null,
    enteredAt: null,
    survivalMs: 0,
    control: { x: 0, y: 0, boost: false },
  };
}

function currentSurvivalMs(player) {
  if (!player) return 0;
  if (player.status === "active" && player.enteredAt) {
    return Math.max(0, Date.now() - player.enteredAt);
  }
  return Math.max(0, Number(player.survivalMs) || 0);
}

function leaderboardEntries() {
  const entries = [...state.leaderboard];
  for (const player of state.players) {
    entries.push({
      id: player.id,
      name: player.name || "",
      survivalMs: currentSurvivalMs(player),
      active: true,
    });
  }
  return entries
    .sort((a, b) => b.survivalMs - a.survivalMs)
    .slice(0, 8)
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      seconds: Math.floor(entry.survivalMs / 1000),
      active: Boolean(entry.active),
    }));
}

function recordSurvival(player) {
  if (!player) return;
  const survivalMs = currentSurvivalMs(player);
  const entry = {
    id: player.id,
    name: player.name || "",
    survivalMs,
    active: false,
  };
  const index = state.leaderboard.findIndex((item) => item.id === player.id);
  if (index >= 0) {
    if (survivalMs > state.leaderboard[index].survivalMs) state.leaderboard[index] = entry;
  } else {
    state.leaderboard.push(entry);
  }
  state.leaderboard.sort((a, b) => b.survivalMs - a.survivalMs);
  state.leaderboard = state.leaderboard.slice(0, 20);
}

function findPlayer(id) {
  return (
    state.players.find((player) => player.id === id) ||
    state.queue.find((player) => player.id === id) ||
    state.drafts.find((player) => player.id === id)
  );
}

function playerStatus(id) {
  const active = state.players.find((player) => player.id === id);
  if (active) return { found: true, status: "active", player: active, queuePosition: 0 };

  const queued = state.queue.find((player) => player.id === id);
  if (queued) {
    return {
      found: true,
      status: "queued",
      player: queued,
      queuePosition: state.queue.indexOf(queued) + 1,
    };
  }

  const draft = state.drafts.find((player) => player.id === id);
  if (draft) return { found: true, status: draft.status, player: draft, queuePosition: 0 };

  return {
    found: false,
    status: state.eliminatedIds.has(id) ? "eliminated" : "missing",
    player: null,
    queuePosition: 0,
  };
}

function runBackgroundRemoval(image, options = {}) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, "remove_background.py");
    fs.mkdirSync(MODEL_DIR, { recursive: true });
    let settled = false;
    const child = spawn(PYTHON_BIN, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        U2NET_HOME: MODEL_DIR,
        USE_REMBG: options.useAi === false ? "0" : (process.env.USE_REMBG || "1"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const finish = (processedImage) => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, image: processedImage });
    };
    const timeout = setTimeout(() => {
      console.warn(`background removal ${options.mode || "ai"} timed out`);
      child.kill();
      if (!settled) {
        settled = true;
        resolve({ ok: false, image, error: "timeout" });
      }
    }, options.timeoutMs || BG_REMOVE_TIMEOUT_MS);
    child.on("close", () => {
      clearTimeout(timeout);
      if (settled) return;
      try {
        const result = JSON.parse(stdout);
        if (result.ok && result.image) {
          finish(result.image);
          return;
        }
      } catch {
        // Fall back to the original image when local processing fails.
      }
      console.warn(`background removal ${options.mode || "ai"} skipped:`, stderr || stdout);
      settled = true;
      resolve({ ok: false, image, error: stderr || stdout });
    });
    child.stdin.end(JSON.stringify({
      image,
      removeBackground: true,
      mode: options.mode || "ai",
    }));
  });
}

async function processImage(image, removeBackground) {
  if (!removeBackground) return { ok: true, image };
  const aiResult = await runBackgroundRemoval(image, {
    mode: "ai",
    useAi: true,
    timeoutMs: BG_REMOVE_TIMEOUT_MS,
  });
  if (aiResult.ok && aiResult.image) return aiResult;

  const fallbackResult = await runBackgroundRemoval(image, {
    mode: "heuristic",
    useAi: false,
    timeoutMs: HEURISTIC_TIMEOUT_MS,
  });
  if (fallbackResult.ok && fallbackResult.image) return fallbackResult;
  return {
    ok: false,
    image: null,
    error: fallbackResult.error || aiResult.error || "background removal failed",
  };
}

function enqueueImageProcessing(image, removeBackground) {
  if (!removeBackground) return Promise.resolve({ ok: true, image });
  return new Promise((resolve) => {
    imageProcessingQueue.push({ image, removeBackground, resolve });
    runNextImageProcessing();
  });
}

async function runNextImageProcessing() {
  if (imageProcessingRunning) return;
  const job = imageProcessingQueue.shift();
  if (!job) return;

  imageProcessingRunning = true;
  try {
    job.resolve(await processImage(job.image, job.removeBackground));
  } catch (error) {
    job.resolve({ ok: false, image: null, error: error.message });
  } finally {
    imageProcessingRunning = false;
    setTimeout(runNextImageProcessing, 0);
  }
}

function removeFrom(list, player) {
  const index = list.indexOf(player);
  if (index >= 0) list.splice(index, 1);
}

function reseatPlayers() {
  state.players.forEach((player, index) => {
    player.slot = index + 1;
    player.status = "active";
  });
}

function promoteQueue() {
  const promoted = [];
  while (state.players.length < MAX_PLAYERS && state.queue.length > 0) {
    const player = state.queue.shift();
    player.status = "active";
    player.slot = state.players.length + 1;
    player.enteredAt = Date.now();
    player.survivalMs = 0;
    player.control = { x: 0, y: 0, boost: false };
    state.players.push(player);
    promoted.push(player);
  }
  if (promoted.length > 0) {
    reseatPlayers();
    for (const player of promoted) broadcast("player", player);
    broadcast("state", publicState());
  }
  return promoted;
}

function enterPlayer(player) {
  removeFrom(state.drafts, player);
  removeFrom(state.queue, player);
  removeFrom(state.players, player);
  player.control = { x: 0, y: 0, boost: false };

  if (state.players.length < MAX_PLAYERS) {
    player.status = "active";
    player.slot = state.players.length + 1;
    player.enteredAt = Date.now();
    player.survivalMs = 0;
    state.players.push(player);
    reseatPlayers();
    broadcast("player", player);
    broadcast("state", publicState());
  } else {
    player.status = "queued";
    player.slot = null;
    player.enteredAt = null;
    player.survivalMs = 0;
    state.queue.push(player);
    broadcast("state", publicState());
  }

  return {
    ok: true,
    player,
    status: player.status,
    queuePosition: player.status === "queued" ? state.queue.indexOf(player) + 1 : 0,
    activePlayers: state.players.length,
    queueCount: state.queue.length,
  };
}

function staticFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

function publicFilePath(urlPathname) {
  const pathname = decodeURIComponent(urlPathname).replace(/^\/+/, "");
  if (pathname.includes("..")) return null;
  const filePath = path.join(PUBLIC_DIR, pathname);
  return filePath.startsWith(PUBLIC_DIR) ? filePath : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/" || url.pathname === "/screen") {
    staticFile(res, path.join(PUBLIC_DIR, "screen.html"));
    return;
  }

  if (url.pathname === "/controller") {
    staticFile(res, path.join(PUBLIC_DIR, "controller.html"));
    return;
  }

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/api/session") {
    const baseUrl = requestBaseUrl(req);
    sendJson(res, 200, {
      sessionId,
      batch: state.batch,
      maxPlayers: MAX_PLAYERS,
      uploadUrl: `${baseUrl}/controller.html`,
      screenUrl: `${baseUrl}/screen?v=${sessionId}`,
      currentHost: req.headers.host,
    });
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      sessionId,
      activePlayers: state.players.length,
      queueCount: state.queue.length,
    });
    return;
  }

  if (url.pathname === "/api/state") {
    sendJson(res, 200, publicState());
    return;
  }

  if (url.pathname === "/api/player-status") {
    if (url.searchParams.get("session") !== sessionId) {
      sendJson(res, 403, { ok: false, error: "session mismatch" });
      return;
    }
    const status = playerStatus(String(url.searchParams.get("playerId") || ""));
    sendJson(res, 200, {
      ok: true,
      found: status.found,
      status: status.status,
      player: status.player,
      queuePosition: status.queuePosition,
      activePlayers: state.players.length,
      queueCount: state.queue.length,
    });
    return;
  }

  if (url.pathname === "/api/join" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req, 1024 * 64));
      if (body.session !== sessionId) {
        sendJson(res, 403, { ok: false, error: "session mismatch" });
        return;
      }

      let player = body.playerId ? findPlayer(String(body.playerId)) : null;
      if (!player || player.batch !== state.batch) {
        player = makePlayer();
        state.drafts.push(player);
      }

      sendJson(res, 200, {
        ok: true,
        player,
        batch: state.batch,
        maxPlayers: MAX_PLAYERS,
        activePlayers: state.players.length,
        queueCount: state.queue.length,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/upload" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req, UPLOAD_LIMIT));
      if (body.session !== sessionId) {
        sendJson(res, 403, { ok: false, error: "session mismatch" });
        return;
      }
      if (!body.image || !/^data:image\/(png|jpeg|webp);base64,/.test(body.image)) {
        sendJson(res, 400, { ok: false, error: "invalid image" });
        return;
      }
      const player = findPlayer(String(body.playerId || ""));
      if (!player) {
        sendJson(res, 404, { ok: false, error: "player not found" });
        return;
      }
      const processed = await enqueueImageProcessing(body.image, body.removeBackground !== false);
      if (!processed.ok || !processed.image) {
        sendJson(res, 422, {
          ok: false,
          error: "background removal failed",
          detail: processed.error || "unable to process image",
        });
        return;
      }
      removeFrom(state.drafts, player);
      removeFrom(state.queue, player);
      removeFrom(state.players, player);
      player.image = processed.image;
      player.imageVersion = (player.imageVersion || 0) + 1;
      player.name = String(body.name || "").trim().slice(0, 20);
      player.uploadedAt = new Date().toISOString();
      player.status = "ready";
      player.slot = null;
      player.enteredAt = null;
      player.survivalMs = 0;
      state.drafts.push(player);
      sendJson(res, 200, {
        ok: true,
        player,
        status: player.status,
        queuePosition: 0,
        activePlayers: state.players.length,
        queueCount: state.queue.length,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/start" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req, 1024 * 64));
      if (body.session !== sessionId) {
        sendJson(res, 403, { ok: false, error: "session mismatch" });
        return;
      }
      const player = findPlayer(String(body.playerId || ""));
      if (!player) {
        sendJson(res, 404, { ok: false, error: "player not found" });
        return;
      }
      if (!player.image) {
        sendJson(res, 409, { ok: false, error: "player not ready" });
        return;
      }
      if (player.status === "active") {
        sendJson(res, 200, {
          ok: true,
          player,
          status: player.status,
          queuePosition: 0,
          activePlayers: state.players.length,
          queueCount: state.queue.length,
        });
        return;
      }
      if (player.status === "queued") {
        sendJson(res, 200, {
          ok: true,
          player,
          status: player.status,
          queuePosition: state.queue.indexOf(player) + 1,
          activePlayers: state.players.length,
          queueCount: state.queue.length,
        });
        return;
      }
      sendJson(res, 200, enterPlayer(player));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/control" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req, 1024 * 64));
      if (body.session !== sessionId) {
        sendJson(res, 403, { ok: false, error: "session mismatch" });
        return;
      }
      const player = state.players.find((item) => item.id === String(body.playerId || ""));
      if (!player) {
        const queued = state.queue.find((item) => item.id === String(body.playerId || ""));
        if (queued) {
          sendJson(res, 202, {
            ok: true,
            status: "queued",
            queuePosition: state.queue.indexOf(queued) + 1,
          });
          return;
        }
        sendJson(res, 404, { ok: false, error: "player not found" });
        return;
      }
      player.control = {
        x: Math.max(-1, Math.min(1, Number(body.x) || 0)),
        y: Math.max(-1, Math.min(1, Number(body.y) || 0)),
        boost: Boolean(body.boost),
      };
      broadcast("control", { playerId: player.id, control: player.control });
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/eliminate" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req, 1024 * 64));
      if (body.session !== sessionId) {
        sendJson(res, 403, { ok: false, error: "session mismatch" });
        return;
      }
      const playerId = String(body.playerId || "");
      const eliminated = state.players.find((player) => player.id === playerId);
      const before = state.players.length;
      state.players = state.players.filter((player) => player.id !== playerId);
      state.players.forEach((player, index) => {
        player.slot = index + 1;
      });
      if (state.players.length !== before) {
        if (eliminated) {
          const survivalMs = currentSurvivalMs(eliminated);
          eliminated.status = "eliminated";
          eliminated.survivalMs = survivalMs;
          eliminated.enteredAt = null;
          recordSurvival(eliminated);
        }
        state.eliminatedIds.add(playerId);
        reseatPlayers();
        broadcast("eliminated", { playerId });
        promoteQueue();
        broadcast("state", publicState());
      }
      sendJson(res, 200, { ok: true, activePlayers: state.players.length });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/reset" && req.method === "POST") {
    state.batch += 1;
    state.players = [];
    state.queue = [];
    state.drafts = [];
    state.leaderboard = [];
    state.eliminatedIds.clear();
    broadcast("batch", publicState());
    sendJson(res, 200, { ok: true });
    return;
  }

  const filePath = publicFilePath(url.pathname);
  if (filePath) {
    staticFile(res, filePath);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.on("connection", (socket) => {
  socket.setNoDelay(true);
});

server.listen(PORT, "0.0.0.0", () => {
  const lanIp = getLanIp();
  console.log(`TV screen: http://localhost:${PORT}/screen`);
  console.log(`Phone URL: http://${lanIp}:${PORT}/controller?session=${sessionId}`);
});
