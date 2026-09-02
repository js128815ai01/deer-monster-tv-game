const params = new URLSearchParams(window.location.search);
let session = params.get("session") || "";
const galleryInput = document.getElementById("galleryFile");
const nameInput = document.getElementById("monsterName");
const removePaper = document.getElementById("removePaper");
const preview = document.getElementById("previewCanvas");
const ctx = preview.getContext("2d");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const controllerRoot = document.getElementById("controllerRoot");
const uploadPanel = document.getElementById("uploadPanel");
const controlPanel = document.getElementById("controlPanel");
const countdownScreen = document.getElementById("countdownScreen");
const countdownNumber = document.getElementById("countdownNumber");
const deathScreen = document.getElementById("deathScreen");
const joystick = document.getElementById("joystick");
const stick = document.getElementById("stick");
const stopBtn = document.getElementById("stopBtn");

let imageReady = false;
let joined = false;
let activePointer = null;
let lastControl = { x: 0, y: 0 };
let playerId = "";
let playerSlot = "";
let lastImageSource = null;
let enteringControl = false;
let eliminated = false;
let stageStarted = false;
let uploadInFlight = false;
let controlInFlight = false;
let controlPending = false;
let lastControlSentAt = 0;
let resendTimer = null;
const CONTROL_SEND_INTERVAL = 22;
const CONTROL_RESEND_INTERVAL = 38;
const TRANSPARENT_UPLOAD_SIZE = 520;
const PHOTO_UPLOAD_SIZE = 640;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function drawEmptyPreview() {
  ctx.clearRect(0, 0, preview.width, preview.height);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(0, 0, preview.width, preview.height);
  ctx.fillStyle = "#aeb9ca";
  ctx.textAlign = "center";
  ctx.font = "32px Microsoft JhengHei, sans-serif";
  ctx.fillText("選擇或拍攝手繪怪物", preview.width / 2, preview.height / 2);
}

function refreshUploadButton() {
  uploadBtn.disabled = !imageReady || uploadInFlight || enteringControl || stageStarted;
}

function sourceSize(source) {
  return {
    width: source.videoWidth || source.naturalWidth || source.width,
    height: source.videoHeight || source.naturalHeight || source.height,
  };
}

function samplePaperColor(pixels) {
  const { width, height, data } = pixels;
  const points = [
    [Math.floor(width * 0.06), Math.floor(height * 0.06)],
    [Math.floor(width * 0.94), Math.floor(height * 0.06)],
    [Math.floor(width * 0.06), Math.floor(height * 0.94)],
    [Math.floor(width * 0.94), Math.floor(height * 0.94)],
    [Math.floor(width * 0.5), Math.floor(height * 0.04)],
  ];
  const colors = points.map(([x, y]) => {
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  });
  return colors.reduce((acc, color) => acc.map((value, i) => value + color[i] / colors.length), [0, 0, 0]);
}

function removeBackground() {
  if (!removePaper.checked) return;
  const pixels = ctx.getImageData(0, 0, preview.width, preview.height);
  const data = pixels.data;
  const paper = samplePaperColor(pixels);
  let minX = preview.width;
  let minY = preview.height;
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < data.length; i += 4) {
    const pixelIndex = i / 4;
    const x = pixelIndex % preview.width;
    const y = Math.floor(pixelIndex / preview.width);
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const bright = (r + g + b) / 3;
    const paperDistance = Math.hypot(r - paper[0], g - paper[1], b - paper[2]);
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    const whitePaper = bright > 168 && saturation < 70;
    const similarPaper = paperDistance < 78 && bright > 118;
    if (whitePaper || similarPaper) {
      const alpha = clamp((paperDistance - 22) * 5.5, 0, 255);
      data[i + 3] = Math.min(data[i + 3], alpha);
    } else if (data[i + 3] > 20) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  ctx.putImageData(pixels, 0, 0);

  const contentW = maxX - minX;
  const contentH = maxY - minY;
  if (contentW > 30 && contentH > 30 && contentW < preview.width * 0.82 && contentH < preview.height * 0.82) {
    const padded = Math.max(contentW, contentH) * 1.28;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const sx = clamp(cx - padded / 2, 0, preview.width - padded);
    const sy = clamp(cy - padded / 2, 0, preview.height - padded);
    const trimmed = document.createElement("canvas");
    trimmed.width = preview.width;
    trimmed.height = preview.height;
    const tctx = trimmed.getContext("2d");
    tctx.clearRect(0, 0, trimmed.width, trimmed.height);
    tctx.drawImage(preview, sx, sy, padded, padded, 0, 0, trimmed.width, trimmed.height);
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.drawImage(trimmed, 0, 0);
  }
}

function cropImageToSquare(source) {
  drawSourceToCanvas(ctx, preview.width, preview.height, source);
  removeBackground();
}

function drawSourceToCanvas(targetCtx, width, height, source) {
  const size = sourceSize(source);
  const side = Math.min(size.width, size.height);
  const sx = (size.width - side) / 2;
  const sy = (size.height - side) / 2;
  targetCtx.clearRect(0, 0, width, height);
  targetCtx.drawImage(source, sx, sy, side, side, 0, 0, width, height);
}

function buildUploadImage() {
  const uploadCanvas = document.createElement("canvas");
  const uploadCtx = uploadCanvas.getContext("2d");
  if (!lastImageSource || removePaper.checked) {
    uploadCanvas.width = TRANSPARENT_UPLOAD_SIZE;
    uploadCanvas.height = TRANSPARENT_UPLOAD_SIZE;
    uploadCtx.drawImage(preview, 0, 0, uploadCanvas.width, uploadCanvas.height);
    return uploadCanvas.toDataURL("image/webp", 0.78);
  }
  uploadCanvas.width = PHOTO_UPLOAD_SIZE;
  uploadCanvas.height = PHOTO_UPLOAD_SIZE;
  drawSourceToCanvas(uploadCtx, uploadCanvas.width, uploadCanvas.height, lastImageSource);
  return uploadCanvas.toDataURL("image/jpeg", 0.82);
}

function loadFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      lastImageSource = img;
      cropImageToSquare(img);
      imageReady = true;
      refreshUploadButton();
      uploadStatus.textContent = "預覽完成，可以送進小鹿號關卡。";
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

galleryInput.addEventListener("change", () => loadFile(galleryInput.files[0]));
removePaper.addEventListener("change", () => {
  if (lastImageSource) cropImageToSquare(lastImageSource);
});

uploadBtn.addEventListener("click", async () => {
  if (!imageReady) return;
  if (!joined) {
    const joinedNow = await joinGame();
    if (!joinedNow) {
      uploadStatus.textContent = "目前無法加入，請稍後再試。";
      refreshUploadButton();
      return;
    }
  }
  await uploadMonster();
});

async function uploadMonster(retried = false) {
  if (!playerId) {
    joined = false;
    refreshUploadButton();
    return;
  }
  uploadInFlight = true;
  refreshUploadButton();
  uploadStatus.textContent = removePaper.checked ? "正在去背，完成後才會送出..." : "正在送出圖片...";
  try {
    const image = buildUploadImage();
    if (image.length > 7 * 1024 * 1024) {
      uploadStatus.textContent = "圖片仍然太大，請靠近角色拍攝或改用較簡單背景。";
      uploadBtn.disabled = false;
      return;
    }
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session,
        playerId,
        name: nameInput.value.trim(),
        image,
        removeBackground: removePaper.checked,
      }),
    });
    const data = await res.json();
    if (!data.ok && data.error === "player not found" && !retried) {
      playerId = "";
      joined = false;
      const joinedNow = await joinGame();
      if (joinedNow) return uploadMonster(true);
    }
    if (!data.ok) throw new Error(data.error || "upload failed");
    uploadStatus.textContent = "去背完成，準備進入小鹿號關卡。";
    startCountdownThenControl();
  } catch (error) {
    uploadStatus.textContent = error.message.includes("background removal failed")
      ? "去背失敗，圖片尚未送出，請重新選取照片再試一次。"
      : `上傳失敗：${error.message}`;
  } finally {
    uploadInFlight = false;
    refreshUploadButton();
  }
}

function startCountdownThenControl() {
  if (enteringControl) return;
  enteringControl = true;
  uploadBtn.disabled = true;
  countdownScreen.hidden = false;
  countdownNumber.textContent = "3";
  let value = 3;
  const timer = setInterval(() => {
    value -= 1;
    if (value > 0) {
      countdownNumber.textContent = String(value);
      return;
    }
    clearInterval(timer);
    enterStage();
  }, 820);
}

async function enterStage() {
  try {
    const res = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, playerId }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "start failed");
    if (data.status === "queued") {
      uploadStatus.textContent = `已完成準備，正在排隊第 ${data.queuePosition} 位。`;
    } else {
      uploadStatus.textContent = "已進場，請看觸控電視上的小鹿號關卡。";
    }
    stageStarted = true;
    playerSlot = data.player.slot || playerSlot;
    countdownScreen.hidden = true;
    uploadPanel.hidden = true;
    controlPanel.hidden = false;
    controllerRoot.classList.add("is-playing");
    centerStick();
  } catch (error) {
    enteringControl = false;
    countdownScreen.hidden = true;
    uploadBtn.disabled = false;
    uploadStatus.textContent = `進場失敗：${error.message}`;
  }
}

function sendControl(x, y) {
  if (!playerId || eliminated) return;
  lastControl = { x, y };
  queueControlSend(false);
}

function queueControlSend(force) {
  if (!playerId || eliminated) return;
  const now = performance.now();
  const wait = force ? 0 : Math.max(0, CONTROL_SEND_INTERVAL - (now - lastControlSentAt));
  if (wait > 0) {
    clearTimeout(resendTimer);
    resendTimer = setTimeout(() => queueControlSend(true), wait);
    return;
  }
  flushControl();
}

function flushControl() {
  if (!playerId || eliminated) return;
  const control = { ...lastControl };
  const payload = JSON.stringify({
    session,
    playerId,
    x: control.x,
    y: control.y,
    boost: Math.hypot(control.x, control.y) > 0.58,
  });
  controlPending = false;
  lastControlSentAt = performance.now();

  controlInFlight = true;
  fetch("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
    cache: "no-store",
  })
    .then((res) => {
      if (res.status === 202) return;
      if (res.status === 404) {
        showEliminated();
      }
    })
    .catch(() => {})
    .finally(() => {
      controlInFlight = false;
      if (controlPending && !eliminated) queueControlSend(true);
    });
}

function showEliminated() {
  if (eliminated) return;
  eliminated = true;
  stageStarted = false;
  activePointer = null;
  lastControl = { x: 0, y: 0 };
  stick.style.transform = "translate(-50%, -50%)";
  countdownScreen.hidden = true;
  uploadPanel.hidden = true;
  controlPanel.hidden = true;
  deathScreen.hidden = false;
  uploadStatus.textContent = "你的怪物已死亡退場。";
}

async function pollPlayerStatus() {
  if (!playerId || eliminated || !stageStarted) return;
  try {
    const res = await fetch(`/api/player-status?session=${encodeURIComponent(session)}&playerId=${encodeURIComponent(playerId)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.status === "eliminated" || data.status === "missing") {
      showEliminated();
      return;
    }
    if (data.status === "queued" && data.queuePosition) {
      uploadStatus.textContent = `已完成準備，正在排隊第 ${data.queuePosition} 位。`;
    }
  } catch {
    // Keep the controller responsive even if a single status check fails.
  }
}

function connectEvents() {
  const events = new EventSource("/events");
  events.addEventListener("eliminated", (event) => {
    const data = JSON.parse(event.data);
    if (data.playerId === playerId) showEliminated();
  });
  events.addEventListener("batch", () => {
    showEliminated();
  });
}

function moveStick(event) {
  event.preventDefault();
  const rect = joystick.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = event.clientX - cx;
  const dy = event.clientY - cy;
  const max = rect.width * 0.34;
  const dist = Math.min(max, Math.hypot(dx, dy));
  const angle = Math.atan2(dy, dx);
  const sx = Math.cos(angle) * dist;
  const sy = Math.sin(angle) * dist;
  stick.style.transform = `translate(calc(-50% + ${sx}px), calc(-50% + ${sy}px))`;
  sendControl(sx / max, sy / max);
}

function centerStick() {
  stick.style.transform = "translate(-50%, -50%)";
  sendControl(0, 0);
  queueControlSend(true);
}

joystick.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  activePointer = event.pointerId;
  joystick.setPointerCapture(activePointer);
  moveStick(event);
});

joystick.addEventListener("pointermove", (event) => {
  if (event.pointerId === activePointer) moveStick(event);
});

joystick.addEventListener("pointerup", (event) => {
  event.preventDefault();
  if (event.pointerId === activePointer) {
    activePointer = null;
    centerStick();
  }
});

joystick.addEventListener("pointercancel", centerStick);
stopBtn.addEventListener("click", centerStick);

setInterval(() => {
  if (Math.abs(lastControl.x) > 0.01 || Math.abs(lastControl.y) > 0.01) {
    queueControlSend(false);
  }
}, CONTROL_RESEND_INTERVAL);

setInterval(pollPlayerStatus, 700);

drawEmptyPreview();

async function joinGame() {
  if (!session) {
    try {
      const res = await fetch("/api/session");
      const info = await res.json();
      session = info.sessionId || "";
    } catch {
      session = "";
    }
    if (!session) {
      uploadStatus.textContent = "無法取得課程場次，請重新整理頁面。";
      return false;
    }
  }
  try {
    const res = await fetch("/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
    });
    const data = await res.json();
    if (!data.ok) {
      uploadStatus.textContent = "目前無法加入，請稍後再試。";
      joined = false;
      refreshUploadButton();
      return false;
    }
    playerId = data.player.id;
    playerSlot = data.player.slot;
    joined = true;
    if (!imageReady) uploadStatus.textContent = "請先選照片，上傳後會自動排隊進場。";
    refreshUploadButton();
    return true;
  } catch (error) {
    uploadStatus.textContent = "無法連到觸控電視，請確認同一個 Wi-Fi。";
    joined = false;
    refreshUploadButton();
    return false;
  }
}

joinGame();
connectEvents();
