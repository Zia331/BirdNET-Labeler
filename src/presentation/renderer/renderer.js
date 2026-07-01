/**
 * @presentation renderer
 *
 * Entry point for the renderer process.  All communication with the main
 * process goes through window.electronAPI (injected by preload.js).
 *
 * State is kept simple and flat: a list of AudioFileDtos plus which one is
 * currently active.  The heavy domain logic lives in the main process.
 */

import { SpectrogramRenderer } from "./SpectrogramRenderer.js";

// ─── App state ────────────────────────────────────────────────────────────────

const state = {
  audioFiles: [], // AudioFileDto[]
  activeFileIndex: -1,
  speciesOptions: [], // SpeciesDto[]
  reviewer: "",
  outputPath: null,
  specRenderer: null,
  audioContext: null,
  currentAudioBuffer: null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const DOM = {
  toolbar: $("toolbar"),
  fileList: $("file-list"),
  filenameSearch: $("filename-search"),
  spectroCanvas: $("spectrogram-canvas"),
  spectroPlaceholder: $("spectrogram-placeholder"),
  spectroMetadata: $("spectrogram-metadata"),
  segmentsContainer: $("segments-container"),
  audioElement: $("audio-player"),
  statusLeft: $("status-left"),
  statusRight: $("status-right"),
  reviewerInput: $("reviewer-input"),
};

// ─── Initialise ───────────────────────────────────────────────────────────────

let globalCursorAnimationId = null;
let spectrogramBackupCanvas = null;
let isTrackingLoopRunning = false; // Strict lock flag to prevent duplicate threads
let lastActiveSegmentIndex = -1;

async function init() {
  // Guard: if preload.js failed to load (e.g. sandbox + local require bug),
  // window.electronAPI will be undefined and every call below will throw a
  // confusing "Cannot read properties of undefined" error.
  // We catch it here with a clear actionable message.
  if (!window.electronAPI) {
    document.body.innerHTML =
      '<div style="color:#e05252;padding:32px;font-family:monospace;font-size:16px">' +
      "<b>Fatal: window.electronAPI is undefined.</b><br><br>" +
      "The preload script did not load correctly.<br>" +
      "Common cause: <code>require()</code> of a local file inside preload.js " +
      "fails in Electron 20+ sandboxed context.<br><br>" +
      "Fix: open preload.js and make sure it only uses built-in Node/Electron modules." +
      "</div>";
    return;
  }

  state.specRenderer = new SpectrogramRenderer(DOM.spectroCanvas);
  state.audioContext = new AudioContext();

  // Restore persisted settings from electron-store (survive app restarts)
  const [savedReviewer, allSpecies] = await Promise.all([
    window.electronAPI.getReviewer(),
    window.electronAPI.getAllSpecies(),
  ]);

  state.reviewer = savedReviewer;
  state.speciesOptions = allSpecies;

  DOM.reviewerInput.value = state.reviewer;

  // Wire toolbar buttons and sidebar filters
  $("btn-open-directory").addEventListener("click", onOpenDirectory);
  const nextBtn = $("btn-next-audio");
  if (nextBtn) {
    nextBtn.addEventListener("click", onNextAudio);
  }
  const prevBtn = $("btn-prev-audio");
  if (prevBtn) {
    prevBtn.addEventListener("click", onPrevAudio);
  }
  $("file-filter").addEventListener("change", renderFileList);
  DOM.reviewerInput.addEventListener("input", async (e) => {
    state.reviewer = e.target.value.trim();
    await window.electronAPI.setReviewer(state.reviewer); // persist immediately
  });
  if (DOM.filenameSearch) {
    DOM.filenameSearch.addEventListener("input", renderFileList);
  }

  setStatus("Ready.  Open a Folder to begin.");

  DOM.statusRight.textContent =
    "© Eco-Acoustics and Spatial Ecology (EASE) Lab, Biodiversity Research Center, Academia Sinica in Taipei, Taiwan";

  // Wire audio playback state directly into the cursor tracking animation loop
  // Trigger cursor loop when music starts
  DOM.audioElement.addEventListener("play", () => {
    if (!isTrackingLoopRunning) {
      startCursorTracking();
    }
  });

  // Handle seeking cleanly (scrubbing while playing or paused)
  DOM.audioElement.addEventListener("seeked", () => {
    // If the loop isn't running, run a single visual refresh frame to update the line position
    if (!isTrackingLoopRunning) {
      startCursorTracking();
      // Instantly kill it so it doesn't loop forever while paused
      setTimeout(() => {
        if (DOM.audioElement.paused && globalCursorAnimationId) {
          cancelAnimationFrame(globalCursorAnimationId);
          globalCursorAnimationId = null;
          isTrackingLoopRunning = false;
        }
      }, 30);
    }
  });

  // Explicit stop lock on pause events
  DOM.audioElement.addEventListener("pause", () => {
    if (globalCursorAnimationId) {
      cancelAnimationFrame(globalCursorAnimationId);
      globalCursorAnimationId = null;
    }
    isTrackingLoopRunning = false;
  });
}

// ─── Toolbar actions ──────────────────────────────────────────────────────────

async function onOpenDirectory() {
  $("btn-open-directory").blur();
  setStatus("Selecting Folder…");

  try {
    const result = await window.electronAPI.openCsvDialog();
    if (!result || !result.csvPath) {
      setStatus("Open cancelled.");
      return;
    }

    const { csvPath, audioBasePath } = result;
    setStatus("Loading detections…");

    // Pass them as two separate arguments here! Preload will handle the rest.
    state.audioFiles = await window.electronAPI.loadDetections(
      csvPath,
      audioBasePath,
    );
    state.activeFileIndex = -1;

    renderFileList();
    clearSpectrogram();
    clearSegments();

    const folderName = csvPath.replace(/\/+$/, "").split("/").pop();
    setStatus(
      `Loaded ${state.audioFiles.length} file(s)  •  Output → labeled_${folderName}.xlsx`,
    );

    if (state.audioFiles.length > 0) {
      setTimeout(() => selectFile(0), 50);
    }
  } catch (err) {
    setStatus(`Error loading CSV: ${err.message}`, true);
    console.error(err);
  }
}

// ─── File list ────────────────────────────────────────────────────────────────

function renderFileList() {
  const filterVal = $("file-filter").value;

  const searchVal = DOM.filenameSearch
    ? DOM.filenameSearch.value.trim().toLowerCase()
    : "";

  DOM.fileList.innerHTML = "";

  const totalFiles = state.audioFiles.length;
  const completedFiles = state.audioFiles.filter((af) => {
    const labeled = af.segments.filter((s) => s.isLabeled).length;
    const total = af.segments.length;
    return labeled === total && total > 0;
  }).length;

  $("file-stats").textContent =
    `Complete: ${completedFiles} / Total: ${totalFiles}`;

  state.audioFiles.forEach((af, idx) => {
    // ─── NEW: Skip if filename doesn't contain the search string ───
    if (searchVal && !af.fileName.toLowerCase().includes(searchVal)) {
      return;
    }

    const labeled = af.segments.filter((s) => s.isLabeled).length;
    const total = af.segments.length;
    const isCompleted = labeled === total && total > 0;

    // Existing completion status filters
    if (filterVal === "incomplete" && isCompleted) return;
    if (filterVal === "completed" && !isCompleted) return;

    const li = document.createElement("li");
    li.dataset.index = idx;
    if (isCompleted) li.classList.add("fully-labeled");
    if (state.activeFileIndex === idx) li.classList.add("active");

    li.innerHTML = `
      <div class="file-name">${af.fileName}</div>
      <div class="file-progress">${labeled}/${total} segments labeled</div>
    `;
    li.addEventListener("click", () => selectFile(idx));
    DOM.fileList.appendChild(li);
  });
}

// ─── File selection ───────────────────────────────────────────────────────────

// Function to generate a valid, un-fragmented WAV header for Chromium
function bufferToWavBlob(buffer) {
  let numOfChan = buffer.numberOfChannels,
    length = buffer.length * numOfChan * 2 + 44,
    bufferArr = new ArrayBuffer(length),
    view = new DataView(bufferArr),
    channels = [],
    i,
    sample,
    offset = 0,
    pos = 0;

  // Write WAV Header descriptors
  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"
  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // chunk length
  setUint16(1); // sample format (raw PCM)
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan); // byte rate
  setUint16(numOfChan * 2); // block align
  setUint16(16); // bits per sample
  setUint32(0x61746164); // "data" chunk
  setUint32(length - pos - 4); // chunk length

  for (i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  while (pos < length) {
    for (i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][offset]));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }

  return new Blob([bufferArr], { type: "audio/wav" });

  function setUint16(data) {
    view.setUint16(pos, data, true);
    pos += 2;
  }
  function setUint32(data) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
}

async function selectFile(idx) {
  state.activeFileIndex = idx;
  const af = state.audioFiles[idx];

  renderFileList();
  clearSegments();
  clearSpectrogram();
  setStatus(`Decoding Audio Stream: ${af.fileName}…`);

  spectrogramBackupCanvas = null;
  isTrackingLoopRunning = false;
  lastActiveSegmentIndex = -1;
  if (globalCursorAnimationId) cancelAnimationFrame(globalCursorAnimationId);

  try {
    const arrayBuffer = await window.electronAPI.readAudio(af.filePath);
    const audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
    state.currentAudioBuffer = audioBuffer;
    af.durationSeconds = audioBuffer.duration;

    // Clean up old references to avoid RAM bloat
    if (DOM.audioElement.src && DOM.audioElement.src.startsWith("blob:")) {
      URL.revokeObjectURL(DOM.audioElement.src);
    }

    // Convert our stable decoded buffer directly into a local Blob URL
    // This stops Range-Request errors because the PCM data stream is locally structured
    const clearWavBlob = bufferToWavBlob(audioBuffer);
    DOM.audioElement.src = URL.createObjectURL(clearWavBlob);
    DOM.audioElement.load();

    // Render the high-definition spectrogram
    state.specRenderer.render(
      audioBuffer,
      af.segmentBoundaries ?? computeBoundaries(af),
    );
    DOM.spectroPlaceholder.style.display = "none";
    updateMetadataDisplay(af);

    renderSegments(af);
    setStatus(
      `${af.fileName}  •  ${audioBuffer.duration.toFixed(2)} s  •  ${audioBuffer.sampleRate} Hz`,
    );
  } catch (err) {
    setStatus(`Playback pipeline configuration failed: ${err.message}`, true);
    console.error(err);
  }
}

function computeBoundaries(af) {
  // Fallback if DTO doesn't carry segmentBoundaries
  return af.segments.slice(1).map((s) => s.startSeconds);
}

// ─── Spectrogram helpers ──────────────────────────────────────────────────────

function clearSpectrogram() {
  const ctx = DOM.spectroCanvas.getContext("2d");
  ctx.clearRect(0, 0, DOM.spectroCanvas.width, DOM.spectroCanvas.height);
  DOM.spectroPlaceholder.style.display = "flex";
  updateMetadataDisplay(null);
}

function updateMetadataDisplay(af) {
  if (!DOM.spectroMetadata) return;

  DOM.spectroMetadata.innerHTML = "";
  DOM.spectroMetadata.style.display = "none";

  if (!af?.metadata) return;

  const { siteCode = "", siteName = "", recordedTime = "" } = af.metadata;
  const items = [];

  if (siteName) {
    const siteValue =
      siteCode && siteCode !== siteName
        ? `${siteName} (${siteCode})`
        : siteName;
    items.push({ label: "Site", value: siteValue });
  } else if (siteCode) {
    items.push({ label: "Site", value: siteCode });
  }

  if (recordedTime) {
    items.push({ label: "Time", value: recordedTime });
  }

  if (items.length === 0) return;

  const fragment = document.createDocumentFragment();
  items.forEach(({ label, value }) => {
    const item = document.createElement("span");
    item.className = "meta-item";

    const labelEl = document.createElement("strong");
    labelEl.textContent = `${label}:`;

    const valueEl = document.createElement("span");
    valueEl.textContent = value;

    item.appendChild(labelEl);
    item.appendChild(valueEl);
    fragment.appendChild(item);
  });

  DOM.spectroMetadata.appendChild(fragment);
  DOM.spectroMetadata.style.display = "flex";
}

function startCursorTracking() {
  // 1. Terminate any active threads instantly
  if (globalCursorAnimationId) {
    cancelAnimationFrame(globalCursorAnimationId);
    globalCursorAnimationId = null;
  }

  const canvas = DOM.spectroCanvas;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;

  // 2. Safety Catch: If our backup canvas hasn't been captured yet, create it now
  if (!spectrogramBackupCanvas) {
    spectrogramBackupCanvas = document.createElement("canvas");
    spectrogramBackupCanvas.width = canvas.width;
    spectrogramBackupCanvas.height = canvas.height;
    const backupCtx = spectrogramBackupCanvas.getContext("2d");
    backupCtx.drawImage(canvas, 0, 0);
  }

  function updateCursor() {
    const duration = DOM.audioElement.duration;
    const currentTime = DOM.audioElement.currentTime;

    if (duration > 0) {
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const progress = currentTime / duration;
      const cursorX = progress * cssW;

      // Reset transforms to completely erase the canvas cleanly
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(spectrogramBackupCanvas, 0, 0);

      // Rescale only to draw the cursor line matrix
      ctx.scale(dpr, dpr);

      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
      ctx.shadowBlur = 4;

      ctx.beginPath();
      ctx.moveTo(cursorX, 0);
      ctx.lineTo(cursorX, cssH);
      ctx.stroke();
      ctx.restore();

      updateActiveSegmentGlow(currentTime);
    }

    // Keep running the loop ONLY if the audio element is playing
    if (!DOM.audioElement.paused && !DOM.audioElement.ended) {
      globalCursorAnimationId = requestAnimationFrame(updateCursor);
    } else {
      isTrackingLoopRunning = false;
    }
  }

  // Fire the engine frame
  isTrackingLoopRunning = true;
  globalCursorAnimationId = requestAnimationFrame(updateCursor);
}

// ─── Segment panels ───────────────────────────────────────────────────────────

function clearSegments() {
  DOM.segmentsContainer.innerHTML = "";
}

function renderSegments(af) {
  DOM.segmentsContainer.innerHTML = "";

  let hasDetections = false;
  for (const seg of af.segments) {
    const detectionsToRender = seg.allDetections || [];
    if (detectionsToRender.length > 0) {
      hasDetections = true;
      for (const det of detectionsToRender) {
        DOM.segmentsContainer.appendChild(buildDetectionRow(af, seg, det));
      }
    }
  }

  if (!hasDetections) {
    DOM.segmentsContainer.innerHTML =
      '<p style="color:var(--muted);padding:8px">No species detected in this file.</p>';
  }
}

function buildDetectionRow(af, seg, det) {
  const row = document.createElement("div");
  row.className = "detection-row-container";
  row.dataset.seg = seg.index;
  row.dataset.speciesId = det.labId;

  // Retrieve existing label for this species in this segment if present
  const labelObj = seg.labels ? seg.labels[det.labId] : null;
  const currentLabelValue = labelObj?.labelValue ?? ""; // Default blank
  const currentNotes = labelObj?.notes ?? ""; // Default blank

  if (currentLabelValue) {
    row.classList.add("confirmed");
  }

  row.innerHTML = `
    <div class="detection-row-main">
      
      <div class="detection-row-top">
        <div class="species-col">
          <div class="species-row-1">
            <span class="species-ch">${det.chineseName || "—"}</span>
            <span class="species-conf">${det.confidence}</span>
            <span class="segment-time-sub">${seg.startSeconds.toFixed(1)}s~${seg.endSeconds.toFixed(1)}s</span>
          </div>
          <div class="species-row-2">
            <span class="species-en">${det.englishName || "—"}</span>
          </div>
        </div>

        <div class="huge-label-group">
          <button type="button" class="switch-btn ${currentLabelValue === "True" ? "active" : ""}" data-val="True">✓ True</button>
          <button type="button" class="switch-btn ${currentLabelValue === "False" ? "active" : ""}" data-val="False">✗ False</button>
          <button type="button" class="switch-btn ${currentLabelValue === "Uncertain" ? "active" : ""}" data-val="Uncertain">? Uncertain</button>
          <button type="button" class="switch-btn ${currentLabelValue === "Bad audio" ? "active" : ""}" data-val="Bad audio">✗ Bad audio</button>
        </div>
      </div>

      <div class="detection-row-bottom">
        <input type="text" class="notes-input" placeholder="備註 Notes (自動儲存 Auto save on blur)" value="${currentNotes}">
      </div>

    </div>
  `;

  // Play audio on row click (excluding inputs and buttons)
  row.addEventListener("click", (e) => {
    const targetTagName = e.target.tagName.toLowerCase();
    if (
      targetTagName === "input" ||
      targetTagName === "button" ||
      e.target.classList.contains("switch-btn")
    ) {
      return;
    }
    DOM.audioElement.currentTime = seg.startSeconds;
    DOM.audioElement
      .play()
      .catch((err) => console.warn("Playback block:", err));
  });

  // Switch buttons handler
  row.querySelectorAll(".switch-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const group = btn.closest(".huge-label-group");
      const wasActive = btn.classList.contains("active");

      if (wasActive) {
        group
          .querySelectorAll(".switch-btn")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      } else {
        group
          .querySelectorAll(".switch-btn")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      }

      const labelValue = btn.dataset.val;
      const notesEl = row.querySelector(".notes-input");
      const notes = notesEl.value.trim();

      await saveLabelForDetection(af, seg, det, labelValue, notes);
    });
  });

  // Notes blur handler
  const notesInput = row.querySelector(".notes-input");
  notesInput.addEventListener("blur", async () => {
    const activeBtn = row.querySelector(".switch-btn.active");
    let labelValue = activeBtn ? activeBtn.dataset.val : "";
    const notes = notesInput.value.trim();

    const existing = seg.labels ? seg.labels[det.labId] : null;
    const existingLabelValue = existing?.labelValue ?? "";
    const existingNotes = existing?.notes ?? "";

    if (labelValue || notes) {
      if (labelValue !== existingLabelValue || notes !== existingNotes) {
        await saveLabelForDetection(af, seg, det, labelValue, notes);
      }
    }
  });

  return row;
}

async function saveLabelForDetection(af, seg, det, labelValue, notes) {
  try {
    await window.electronAPI.saveLabel({
      audioFilePath: af.id,
      segmentIndex: seg.index,
      speciesLabId: det.labId,
      notes,
      reviewer: state.reviewer,
      labelValue,
    });

    seg.labels = seg.labels || {};
    seg.labels[det.labId] = { speciesLabId: det.labId, notes, labelValue };

    // Update segment's isLabeled state (strictly true ONLY if all detections are labeled)
    const detectionsToRender = seg.allDetections || [];
    const totalToLabel = detectionsToRender.length;
    const labeledCount = detectionsToRender.filter(
      (d) => !!seg.labels[d.labId],
    ).length;
    seg.isLabeled = totalToLabel > 0 && labeledCount === totalToLabel;

    // Visual updates
    const container = document.querySelector(
      `.detection-row-container[data-seg="${seg.index}"][data-species-id="${det.labId}"]`,
    );
    if (container) {
      container.classList.add("confirmed");
    }

    renderFileList();

    setStatus(
      `Saved: ${af.fileName} seg ${seg.index + 1} (${det.chineseName}) → ${labelValue}`,
    );
  } catch (err) {
    setStatus(`Save error: ${err.message}`, true);
    console.error(err);
  }
}

function onNextAudio() {
  if (
    state.activeFileIndex >= 0 &&
    state.activeFileIndex < state.audioFiles.length - 1
  ) {
    selectFile(state.activeFileIndex + 1);
  }
}

function onPrevAudio() {
  if (state.activeFileIndex > 0) {
    selectFile(state.activeFileIndex - 1);
  }
}

function updateActiveSegmentGlow(currentTime) {
  const activeFile = state.audioFiles[state.activeFileIndex];
  if (!activeFile) return;

  const activeSegmentIndex = Math.floor(currentTime / 3.0);
  if (activeSegmentIndex === lastActiveSegmentIndex) return;
  lastActiveSegmentIndex = activeSegmentIndex;

  const rows = DOM.segmentsContainer.querySelectorAll(
    ".detection-row-container",
  );
  rows.forEach((row) => {
    const segIdx = parseInt(row.dataset.seg, 10);
    if (segIdx === activeSegmentIndex) {
      row.classList.add("glow-up");
      row.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      row.classList.remove("glow-up");
    }
  });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  DOM.statusLeft.textContent = msg;
  DOM.statusLeft.style.color = isError ? "var(--danger)" : "";
}

// Re-render spectrogram when window resizes (canvas CSS size changes)
const resizeObserver = new ResizeObserver(() => {
  if (state.currentAudioBuffer && state.activeFileIndex >= 0) {
    const af = state.audioFiles[state.activeFileIndex];
    state.specRenderer.render(
      state.currentAudioBuffer,
      af.segmentBoundaries ?? computeBoundaries(af),
    );
  }
});
resizeObserver.observe(DOM.spectroCanvas);

// ─── Boot ─────────────────────────────────────────────────────────────────────
init().catch(console.error);
