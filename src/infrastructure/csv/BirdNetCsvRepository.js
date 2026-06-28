'use strict';

const fs   = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

/**
 * @infrastructure csv
 *
 * Parses the CSV files produced by BirdNET-Analyzer.
 *
 * Supported column layouts
 * ────────────────────────
 * Layout A (BirdNET-Analyzer ≥ 2.4, comma-separated)
 *   filepath, start, end, scientific_name, common_name, confidence, label
 *   where "label" = eBird species code
 *
 * Layout B (BirdNET-Analyzer table export, may be tab-separated)
 *   Selection, View, Channel, Begin Time (s), End Time (s),
 *   Low Freq (Hz), High Freq (Hz), Species Code, Common Name, Confidence
 *
 * The repository normalises both layouts into the same internal shape:
 *   { filePath, speciesCode, startSeconds, endSeconds, confidence }
 */
class BirdNetCsvRepository {
  /**
   * @param {string} csvPath - Absolute path to the BirdNET output CSV or a folder of selection tables
   * @returns {Promise<RawDetectionRow[]>}
   */
  async parseFromCsv(csvPath) {
    const stat = fs.statSync(csvPath);
    const filesToParse = [];

    if (stat.isDirectory()) {
      const files = fs.readdirSync(csvPath);
      for (const file of files) {
        const fullPath = path.join(csvPath, file);
        const fileStat = fs.statSync(fullPath);
        if (fileStat.isFile()) {
          const lower = file.toLowerCase();
          if (
            lower.endsWith('.birdnet.selection.table.txt') ||
            lower.endsWith('.selection.table.txt') ||
            lower.endsWith('.csv') ||
            (lower.endsWith('.txt') && !lower.includes('readme') && !lower.includes('license'))
          ) {
            filesToParse.push(fullPath);
          }
        }
      }
    } else {
      filesToParse.push(csvPath);
    }

    const allRows = [];
    const audioDir = stat.isDirectory() ? csvPath : path.dirname(csvPath);

    for (const file of filesToParse) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.trim()) continue;

        // Auto-detect delimiter
        const delimiter = raw.includes('\t') ? '\t' : ',';

        const records = parse(raw, {
          columns: true,
          skip_empty_lines: true,
          delimiter,
          trim: true,
        });

        if (records.length === 0) continue;

        const layout = this._detectLayout(records[0]);

        const fileRows = records
          .map(row => this._normalise(row, layout, audioDir, file))
          .filter(Boolean);

        allRows.push(...fileRows);
      } catch (err) {
        console.warn(`[BirdNetCsvRepository] Failed to parse file ${file}:`, err.message);
      }
    }

    return allRows;
  }

  // ─── private ─────────────────────────────────────────────────────────────────

  _detectLayout(firstRow) {
    const keys = Object.keys(firstRow);
    if (keys.includes('filepath') || keys.includes('Filepath'))    return 'A';
    if (keys.includes('Begin Time (s)') || keys.includes('Species Code')) return 'B';
    // Fallback: try to guess
    return 'A';
  }

  _normalise(row, layout, audioDir, csvPath) {
    try {
      if (layout === 'A') {
        const rawPath = row['filepath'] ?? row['Filepath'] ?? row['File'] ?? row['file'];
        return {
          filePath:     this._resolvePath(rawPath, audioDir),
          speciesCode:  row['label'] ?? row['Species Code'] ?? row['Scientific name'] ?? row['Scientific Name'] ?? row['Common name'] ?? row['Common Name'] ?? '',
          startSeconds: parseFloat(row['start'] ?? row['Start (s)'] ?? row['Begin Time (s)'] ?? 0),
          endSeconds:   parseFloat(row['end']   ?? row['End (s)']   ?? row['End Time (s)']   ?? 3),
          confidence:   parseFloat(row['confidence'] ?? row['Confidence'] ?? 0),
        };
      } else {
        // Layout B — the CSV is per-file; filepath comes from the CSV filename
        // Users should run BirdNET per-file and name the CSV after the audio file
        let audioFile = row['Begin Path'] ?? row['filepath'] ?? row['Filepath'] ?? row['File'] ?? row['file'];
        if (!audioFile && csvPath) {
          const base = path.basename(csvPath);
          if (base.endsWith('.BirdNET.selection.table.txt')) {
            audioFile = base.slice(0, -'.BirdNET.selection.table.txt'.length) + '.wav';
          } else if (base.endsWith('.selection.table.txt')) {
            audioFile = base.slice(0, -'.selection.table.txt'.length) + '.wav';
          } else {
            audioFile = path.basename(csvPath, path.extname(csvPath)) + '.wav';
          }
        }
        const guessedAudio = this._resolvePath(audioFile || (path.basename(audioDir) + '.wav'), audioDir);
        return {
          filePath:     guessedAudio,
          speciesCode:  row['Species Code'] ?? row['label'] ?? row['Scientific name'] ?? row['Scientific Name'] ?? row['Common name'] ?? row['Common Name'] ?? '',
          startSeconds: parseFloat(row['Begin Time (s)'] ?? row['start'] ?? row['Start (s)'] ?? 0),
          endSeconds:   parseFloat(row['End Time (s)']   ?? row['end']   ?? row['End (s)']   ?? 3),
          confidence:   parseFloat(row['Confidence']     ?? row['confidence'] ?? 0),
        };
      }
    } catch {
      return null;
    }
  }

  _resolvePath(rawPath, audioDir) {
    if (!rawPath) return audioDir;
    return path.isAbsolute(rawPath) ? rawPath : path.join(audioDir, rawPath);
  }
}

module.exports = BirdNetCsvRepository;
