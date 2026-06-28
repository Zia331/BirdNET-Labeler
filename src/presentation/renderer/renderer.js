/**
 * @presentation renderer
 *
 * Entry point for the renderer process.  All communication with the main
 * process goes through window.electronAPI (injected by preload.js).
 *
 * State is kept simple and flat: a list of AudioFileDtos plus which one is
 * currently active.  The heavy domain logic lives in the main process.
 */

import { SpectrogramRenderer } from './SpectrogramRenderer.js';

// ─── App state ────────────────────────────────────────────────────────────────

const state = {
  audioFiles:      [],     // AudioFileDto[]
  activeFileIndex: -1,
  speciesOptions:  [],     // SpeciesDto[]
  reviewer:        '',
  outputPath:      null,
  specRenderer:    null,
  audioContext:    null,
  currentAudioBuffer: null
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const DOM = {
  toolbar:            $('toolbar'),
  fileList:           $('file-list'),
  spectroCanvas:      $('spectrogram-canvas'),
  spectroPlaceholder: $('spectrogram-placeholder'),
  segmentsContainer:  $('segments-container'),
  audioElement:       $('audio-player'),
  statusLeft:         $('status-left'),
  statusRight:        $('status-right'),
  reviewerInput:      $('reviewer-input'),
};

// ─── Initialise ───────────────────────────────────────────────────────────────

let globalCursorAnimationId = null;
let spectrogramBackupCanvas = null; 
let isTrackingLoopRunning = false;   // Strict lock flag to prevent duplicate threads

async function init() {
  // Guard: if preload.js failed to load (e.g. sandbox + local require bug),
  // window.electronAPI will be undefined and every call below will throw a
  // confusing "Cannot read properties of undefined" error.
  // We catch it here with a clear actionable message.
  if (!window.electronAPI) {
    document.body.innerHTML =
      '<div style="color:#e05252;padding:32px;font-family:monospace;font-size:13px">' +
      '<b>Fatal: window.electronAPI is undefined.</b><br><br>' +
      'The preload script did not load correctly.<br>' +
      'Common cause: <code>require()</code> of a local file inside preload.js ' +
      'fails in Electron 20+ sandboxed context.<br><br>' +
      'Fix: open preload.js and make sure it only uses built-in Node/Electron modules.' +
      '</div>';
    return;
  }

  state.specRenderer = new SpectrogramRenderer(DOM.spectroCanvas);
  state.audioContext = new AudioContext();

  // Restore persisted settings from electron-store (survive app restarts)
  const [savedReviewer, allSpecies] = await Promise.all([
    window.electronAPI.getReviewer(),
    window.electronAPI.getAllSpecies(),
  ]);

  state.reviewer       = savedReviewer;
  state.speciesOptions = allSpecies;

  // Populate global datalist for species filtering
  const datalist = document.createElement('datalist');
  datalist.id = 'species-list';
  datalist.innerHTML = state.speciesOptions.map(sp => {
    const readableName = `${sp.chineseName} (${sp.englishName})`;
    return `<option value="${readableName}" data-id="${sp.labId}"></option>`;
  }).join('');
  document.body.appendChild(datalist);

  DOM.reviewerInput.value = state.reviewer;

  // Wire toolbar buttons and sidebar filters
  $('btn-open-csv').addEventListener('click', onOpenCsv);
  $('file-filter').addEventListener('change', renderFileList);
  DOM.reviewerInput.addEventListener('input', async e => {
    state.reviewer = e.target.value.trim();
    await window.electronAPI.setReviewer(state.reviewer);   // persist immediately
  });

  setStatus('Ready.  Open a Folder to begin.');

  DOM.statusRight.textContent = '© Eco-Acoustics and Spatial Ecology (EASE) Lab, Biodiversity Research Center, Academia Sinica in Taipei, Taiwan';

  // Wire audio playback state directly into the cursor tracking animation loop
  // Trigger cursor loop when music starts
  DOM.audioElement.addEventListener('play', () => {
    if (!isTrackingLoopRunning) {
      startCursorTracking();
    }
  });

  // Handle seeking cleanly (scrubbing while playing or paused)
  DOM.audioElement.addEventListener('seeked', () => {
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
  DOM.audioElement.addEventListener('pause', () => {
    if (globalCursorAnimationId) {
      cancelAnimationFrame(globalCursorAnimationId);
      globalCursorAnimationId = null;
    }
    isTrackingLoopRunning = false;
  });
}

// ─── Toolbar actions ──────────────────────────────────────────────────────────

async function onOpenCsv() {
  $('btn-open-csv').blur();
  setStatus('Selecting Folder…');

  try {
    const result = await window.electronAPI.openCsvDialog(); 
    if (!result || !result.csvPath) {
      setStatus('Open cancelled.');
      return;
    }

    const { csvPath, audioBasePath } = result;
    setStatus('Loading detections…');

    // Pass them as two separate arguments here! Preload will handle the rest.
    state.audioFiles = await window.electronAPI.loadDetections(csvPath, audioBasePath);
    state.activeFileIndex = -1;

    renderFileList();
    clearSpectrogram();
    clearSegments();

    const folderName = csvPath.replace(/\/+$/, '').split('/').pop();
    setStatus(`Loaded ${state.audioFiles.length} file(s)  •  Output → labeled_${folderName}.xlsx`);

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
  const filterVal = $('file-filter').value;
  DOM.fileList.innerHTML = '';

  const totalFiles = state.audioFiles.length;
  const completedFiles = state.audioFiles.filter(af => {
    const labeled = af.segments.filter(s => s.isLabeled).length;
    const total   = af.segments.length;
    return labeled === total && total > 0;
  }).length;

  $('file-stats').textContent = `Complete: ${completedFiles} / Total: ${totalFiles}`;

  state.audioFiles.forEach((af, idx) => {
    const labeled = af.segments.filter(s => s.isLabeled).length;
    const total   = af.segments.length;
    const isCompleted = labeled === total && total > 0;

    if (filterVal === 'incomplete' && isCompleted) return;
    if (filterVal === 'completed' && !isCompleted) return;

    const li = document.createElement('li');
    li.dataset.index = idx;
    if (isCompleted) li.classList.add('fully-labeled');
    if (state.activeFileIndex === idx) li.classList.add('active');

    li.innerHTML = `
      <div class="file-name">${af.fileName}</div>
      <div class="file-progress">${labeled}/${total} segments labeled</div>
    `;
    li.addEventListener('click', () => selectFile(idx));
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
      channels = [], i, sample,
      offset = 0,
      pos = 0;

  // Write WAV Header descriptors
  setUint32(0x46464952);                         // "RIFF"
  setUint32(length - 8);                         // file length - 8
  setUint32(0x45564157);                         // "WAVE"
  setUint32(0x20746d66);                         // "fmt " chunk
  setUint32(16);                                 // chunk length
  setUint16(1);                                  // sample format (raw PCM)
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan);  // byte rate
  setUint16(numOfChan * 2);                      // block align
  setUint16(16);                                 // bits per sample
  setUint32(0x61746164);                         // "data" chunk
  setUint32(length - pos - 4);                   // chunk length

  for (i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  while (pos < length) {
    for (i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][offset]));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }

  return new Blob([bufferArr], { type: 'audio/wav' });

  function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
  function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }
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
  if (globalCursorAnimationId) cancelAnimationFrame(globalCursorAnimationId);

  try {
    const arrayBuffer = await window.electronAPI.readAudio(af.filePath);
    const audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer);
    state.currentAudioBuffer = audioBuffer;
    af.durationSeconds = audioBuffer.duration;

    // Clean up old references to avoid RAM bloat
    if (DOM.audioElement.src && DOM.audioElement.src.startsWith('blob:')) {
      URL.revokeObjectURL(DOM.audioElement.src);
    }

    // Convert our stable decoded buffer directly into a local Blob URL
    // This stops Range-Request errors because the PCM data stream is locally structured
    const clearWavBlob = bufferToWavBlob(audioBuffer);
    DOM.audioElement.src = URL.createObjectURL(clearWavBlob);
    DOM.audioElement.load(); 

    // Render the high-definition spectrogram
    state.specRenderer.render(audioBuffer, af.segmentBoundaries ?? computeBoundaries(af));
    DOM.spectroPlaceholder.style.display = 'none';

    renderSegments(af);
    setStatus(`${af.fileName}  •  ${audioBuffer.duration.toFixed(2)} s  •  ${audioBuffer.sampleRate} Hz`);
  } catch (err) {
    setStatus(`Playback pipeline configuration failed: ${err.message}`, true);
    console.error(err);
  }
}

function computeBoundaries(af) {
  // Fallback if DTO doesn't carry segmentBoundaries
  return af.segments.slice(1).map(s => s.startSeconds);
}

// ─── Spectrogram helpers ──────────────────────────────────────────────────────

function clearSpectrogram() {
  const ctx = DOM.spectroCanvas.getContext('2d');
  ctx.clearRect(0, 0, DOM.spectroCanvas.width, DOM.spectroCanvas.height);
  DOM.spectroPlaceholder.style.display = 'flex';
}

function startCursorTracking() {
  // 1. Terminate any active threads instantly
  if (globalCursorAnimationId) {
    cancelAnimationFrame(globalCursorAnimationId);
    globalCursorAnimationId = null;
  }

  const canvas = DOM.spectroCanvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // 2. Safety Catch: If our backup canvas hasn't been captured yet, create it now
  if (!spectrogramBackupCanvas) {
    spectrogramBackupCanvas = document.createElement('canvas');
    spectrogramBackupCanvas.width = canvas.width;
    spectrogramBackupCanvas.height = canvas.height;
    const backupCtx = spectrogramBackupCanvas.getContext('2d');
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
      
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 4;
      
      ctx.beginPath();
      ctx.moveTo(cursorX, 0);
      ctx.lineTo(cursorX, cssH);
      ctx.stroke();
      ctx.restore();
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
  DOM.segmentsContainer.innerHTML = '';
}

function renderSegments(af) {
  DOM.segmentsContainer.innerHTML = '';

  if (af.segments.length === 0) {
    DOM.segmentsContainer.innerHTML = '<p style="color:var(--muted);padding:8px">No segments detected.</p>';
    return;
  }

  for (const seg of af.segments) {
    DOM.segmentsContainer.appendChild(buildSegmentPanel(af, seg));
  }
}

function buildSegmentPanel(af, seg) {
  const panel = document.createElement('div');
  panel.className = 'segment-panel' + (seg.isLabeled ? ' confirmed' : '');
  panel.id = `seg-panel-${seg.index}`;
  
  // Make it visually clear that the panel is interactive
  panel.style.cursor = 'pointer'; 

  const det = seg.detection;
  const defaultLabId = seg.label?.speciesLabId ?? det?.labId ?? 'BACKGROUND';
  const selectedSp = state.speciesOptions.find(sp => sp.labId === defaultLabId);
  const defaultDisplayValue = selectedSp ? `${selectedSp.chineseName} (${selectedSp.englishName})` : '';

  // Cleanly determine the active label state, defaulting to 'TP' if undefined
  const currentLabel = seg.label?.labelValue ?? 'TP';

  panel.innerHTML = `
    <div class="seg-header">
      <span class="seg-title">Seg ${seg.index + 1}  (${seg.startSeconds.toFixed(1)}s – ${seg.endSeconds.toFixed(1)}s)</span>
      <span class="seg-status">${seg.isLabeled ? '✓ Confirmed' : 'Pending'}</span>
    </div>

    <div class="detection-info">
      <span class="det-label">BirdNET: </span>
      <span class="det-value">${det ? `${det.chineseName || det.ebirdCode}` : '—'}</span>
      ${det ? `<span class="det-conf">${(det.confidence * 100).toFixed(1)}%</span>` : ''}
      ${det?.englishName ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">${det.englishName}  •  <em>${det.scientificName}</em></div>` : ''}
    </div>

    <div>
      <label>確認物種 (Confirm species)</label>
      <input type="text" 
             class="species-input" 
             data-seg="${seg.index}" 
             data-selected-id="${defaultLabId}" 
             list="species-list" 
             value="${defaultDisplayValue}" 
             placeholder="Type to filter species..." 
             style="width: 100%; padding: 6px; background: #1e1e2f; color: #c5c5d2; border: 1px solid #3e3e5a; border-radius: 4px; font-size: 13px;">
    </div>

    <div>
      <label>標記分類 (Label type)</label>
      <div class="label-switch-group">
        <button type="button" class="switch-btn ${currentLabel === 'TP' ? 'active' : ''}" data-val="TP">✓ TP</button>
        <button type="button" class="switch-btn ${currentLabel === 'FP' ? 'active' : ''}" data-val="FP">✗ FP</button>
        <button type="button" class="switch-btn ${currentLabel === 'Uncertain' ? 'active' : ''}" data-val="Uncertain">? Uncertain</button>
      </div>
    </div>

    <div>
      <label>備註 (Notes)</label>
      <input type="text" class="notes-input" placeholder="optional notes…" value="${seg.label?.notes ?? ''}">
    </div>

    <button class="btn-success confirm-btn" data-file="${af.id}" data-seg="${seg.index}">
      ${seg.isLabeled ? '✓ Re-confirm' : '✓ Confirm'}
    </button>
  `;

  // ─── NEW: Auto Skip & Play Audio on Panel Click ───────────────────────────
  panel.addEventListener('click', (e) => {
    // Safety Guard: Don't skip/play if the user is interacting with form inputs or buttons
    const targetTagName = e.target.tagName.toLowerCase();
    if (targetTagName === 'input' || targetTagName === 'button' || e.target.classList.contains('switch-btn')) {
      return; 
    }

    // Jump to the start segment bounds and force playback immediately
    DOM.audioElement.currentTime = seg.startSeconds;
    DOM.audioElement.play().catch(err => console.warn('Playback block:', err));
  });

  // ─── System Listeners ─────────────────────────────
  const input = panel.querySelector('.species-input');
  input.addEventListener('input', () => {
    const val = input.value.trim();
    const option = document.querySelector(`#species-list option[value="${val}"]`);
    if (option) {
      input.dataset.selectedId = option.dataset.id; 
    } else {
      input.dataset.selectedId = ""; 
    }
  });

  panel.querySelectorAll('.label-switch-group .switch-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const group = btn.closest('.label-switch-group');
      group.querySelectorAll('.switch-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  panel.querySelector('.confirm-btn').addEventListener('click', () =>
    onConfirm(af, seg, panel)
  );

  return panel;
}

// ─── Confirm handler ──────────────────────────────────────────────────────────

async function onConfirm(af, seg, panel) {
  const input        = panel.querySelector('.species-input');
  const activeSwitch = panel.querySelector('.switch-btn.active');
  const notesEl      = panel.querySelector('.notes-input');
  const btn          = panel.querySelector('.confirm-btn');

  // Read straight from our hidden state attribute instead of scraping visual strings!
  let speciesLabId = input.dataset.selectedId;

  // Fallback: If the user didn't fire an input click event but typed an exact matching Chinese name manually
  if (!speciesLabId) {
    const manualText = input.value.trim();
    const found = state.speciesOptions.find(sp => 
      sp.chineseName === manualText || 
      `${sp.chineseName} (${sp.englishName})` === manualText
    );
    if (found) speciesLabId = found.labId;
  }

  // Strictly check if the ID is supported inside our backend repository list
  const isValid = state.speciesOptions.some(sp => sp.labId === speciesLabId);
  if (!isValid) {
    alert(`Invalid species: "${input.value}". Please select a valid option from the dropdown.`);
    return;
  }

  const labelValue = activeSwitch ? activeSwitch.dataset.val : 'TP';
  const notes      = notesEl.value.trim();

  btn.disabled  = true;
  btn.textContent = 'Saving…';

  try {
    await window.electronAPI.saveLabel({
      audioFilePath: af.id,
      segmentIndex:  seg.index,
      speciesLabId, // Transmits the clean target ID ("TW_BAR1") safely to Excel
      notes,
      reviewer: state.reviewer,
      labelValue,
    });

    seg.isLabeled = true;
    seg.label     = { speciesLabId, notes, labelValue };

    panel.classList.add('confirmed');
    panel.querySelector('.seg-status').textContent = '✓ Confirmed';
    btn.textContent = '✓ Re-confirm';

    renderFileList();
    
    // Status text uses clean display names instead of code values
    const spObj = state.speciesOptions.find(sp => sp.labId === speciesLabId);
    setStatus(`Saved: ${af.fileName} seg ${seg.index + 1} → ${spObj?.chineseName || speciesLabId} (${labelValue})`);
  } catch (err) {
    setStatus(`Save error: ${err.message}`, true);
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  DOM.statusLeft.textContent = msg;
  DOM.statusLeft.style.color = isError ? 'var(--danger)' : '';
}

// Re-render spectrogram when window resizes (canvas CSS size changes)
const resizeObserver = new ResizeObserver(() => {
  if (state.currentAudioBuffer && state.activeFileIndex >= 0) {
    const af = state.audioFiles[state.activeFileIndex];
    state.specRenderer.render(
      state.currentAudioBuffer,
      af.segmentBoundaries ?? computeBoundaries(af)
    );
  }
});
resizeObserver.observe(DOM.spectroCanvas);

// ─── Boot ─────────────────────────────────────────────────────────────────────
init().catch(console.error);
