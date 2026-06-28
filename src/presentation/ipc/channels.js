'use strict';

/**
 * All IPC channel names in one place.
 *
 * ⚠  DO NOT require() this file from preload.js.
 *    Electron 20+ sandboxes the preload context; local requires fail there.
 *    Channel strings are INLINED directly in preload.js and must be kept
 *    in sync manually when you add or rename a channel here.
 *    This file is consumed only by the (non-sandboxed) main process.
 */
const CHANNELS = {
  // Dialogs
  OPEN_CSV_DIALOG:   'dialog:open-csv',
  OPEN_AUDIO_DIALOG: 'dialog:open-audio-dir',
  OPEN_EXCEL_DIALOG: 'dialog:open-excel',

  // Detections
  LOAD_DETECTIONS:   'detections:load',     // { csvPath, audioBasePath } → AudioFileDto[]

  // Audio
  READ_AUDIO:        'audio:read',           // { audioPath } → ArrayBuffer

  // Species
  GET_ALL_SPECIES:   'species:get-all',      // → SpeciesDto[]

  // Labels
  SAVE_LABEL:        'labels:save',          // LabelDto → { ok, labelTimestamp }
  SET_OUTPUT_PATH:   'labels:set-output',    // { filePath }
  GET_OUTPUT_PATH:   'labels:get-output',    // → string | null

  // Settings (persisted via electron-store)
  GET_REVIEWER:      'settings:get-reviewer',  // → string
  SET_REVIEWER:      'settings:set-reviewer',  // { name }
};

module.exports = CHANNELS;
