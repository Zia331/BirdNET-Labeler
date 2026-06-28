'use strict';

/**
 * preload.js
 *
 * ⚠  SANDBOX RULE: never require() local project files here.
 *    Electron 20+ sandboxes the preload context; only built-in
 *    Node/Electron modules can be required.  Channel names are
 *    inlined below — keep them in sync with channels.js manually.
 */

const { contextBridge, ipcRenderer } = require('electron');

// ── Channel names (mirror of src/presentation/ipc/channels.js) ───────────────
const CH = {
  OPEN_CSV_DIALOG:   'dialog:open-csv',
  OPEN_AUDIO_DIALOG: 'dialog:open-audio-dir',
  OPEN_EXCEL_DIALOG: 'dialog:open-excel',

  LOAD_DETECTIONS:   'detections:load',
  READ_AUDIO:        'audio:read',
  GET_ALL_SPECIES:   'species:get-all',

  SAVE_LABEL:        'labels:save',
  SET_OUTPUT_PATH:   'labels:set-output',
  GET_OUTPUT_PATH:   'labels:get-output',

  GET_REVIEWER:      'settings:get-reviewer',
  SET_REVIEWER:      'settings:set-reviewer',
};

// ── Safe API surface exposed to the renderer ──────────────────────────────────
contextBridge.exposeInMainWorld('electronAPI', {

  // Dialogs — open in the last-used directory automatically
  openCsvDialog:   ()                      => ipcRenderer.invoke(CH.OPEN_CSV_DIALOG),
  openAudioDialog: ()                      => ipcRenderer.invoke(CH.OPEN_AUDIO_DIALOG),
  openExcelDialog: ()                      => ipcRenderer.invoke(CH.OPEN_EXCEL_DIALOG),

  // Detections
  /** @returns {Promise<AudioFileDto[]>} */
  loadDetections:  (csvPath, audioBasePath)=> ipcRenderer.invoke(CH.LOAD_DETECTIONS, { csvPath, audioBasePath }),

  // Audio — returns a properly-copied ArrayBuffer (no shared-pool baggage)
  /** @returns {Promise<ArrayBuffer>} */
  readAudio:       (audioPath)             => ipcRenderer.invoke(CH.READ_AUDIO, { audioPath }),

  // Species
  /** @returns {Promise<SpeciesDto[]>} */
  getAllSpecies:    ()                      => ipcRenderer.invoke(CH.GET_ALL_SPECIES),

  // Labels
  setOutputPath:   (filePath)              => ipcRenderer.invoke(CH.SET_OUTPUT_PATH, { filePath }),
  /** @returns {Promise<string|null>} */
  getOutputPath:   ()                      => ipcRenderer.invoke(CH.GET_OUTPUT_PATH),
  /**
   * @param {{ audioFilePath, segmentIndex, speciesLabId, notes, reviewer }} dto
   * @returns {Promise<{ ok: boolean, labelTimestamp: string }>}
   */
  saveLabel:       (dto)                   => ipcRenderer.invoke(CH.SAVE_LABEL, dto),

  // Settings — persisted across restarts via electron-store
  /** @returns {Promise<string>} */
  getReviewer:     ()                      => ipcRenderer.invoke(CH.GET_REVIEWER),
  /** @returns {Promise<{ ok: boolean }>} */
  setReviewer:     (name)                  => ipcRenderer.invoke(CH.SET_REVIEWER, { name }),
});
