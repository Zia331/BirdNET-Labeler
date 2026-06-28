'use strict';

/**
 * @infrastructure persistence
 *
 * Centralises all electron-store read/write calls.
 * The rest of the codebase never touches electron-store directly.
 *
 * Persisted keys
 * ──────────────
 *  outputPath      – absolute path to the current labels.xlsx
 *  reviewer        – last-used reviewer name
 *  lastCsvPath     – last CSV file opened (restores the Open dialog directory)
 *  lastAudioPath   – last audio directory opened
 */
class AppStore {
  constructor() {
    // Lazy-require: electron-store imports Electron internals and must not
    // be required before the app 'ready' event.
    const Store = require('electron-store');
    this._store = new Store({
      name: 'birdnet-labeler-settings',
      schema: {
        outputPath:    { type: 'string'  },
        reviewer:      { type: 'string', default: '' },
        lastCsvPath:   { type: 'string'  },
        lastAudioPath: { type: 'string'  },
      },
    });
  }

  // ── output path ───────────────────────────────────────────────────────────
  getOutputPath()         { return this._store.get('outputPath', null); }
  setOutputPath(p)        { this._store.set('outputPath', p); }

  // ── reviewer ──────────────────────────────────────────────────────────────
  getReviewer()           { return this._store.get('reviewer', ''); }
  setReviewer(name)       { this._store.set('reviewer', name || ''); }

  // ── last-used directories (for dialog defaultPath) ────────────────────────
  getLastCsvPath()        { return this._store.get('lastCsvPath',   null); }
  setLastCsvPath(p)       { this._store.set('lastCsvPath', p); }

  getLastAudioPath()      { return this._store.get('lastAudioPath', null); }
  setLastAudioPath(p)     { this._store.set('lastAudioPath', p); }
}

module.exports = AppStore;
