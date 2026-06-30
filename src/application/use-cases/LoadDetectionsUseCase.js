'use strict';

const path      = require('path');
const fs        = require('fs');
const AudioFile = require('../../domain/entities/AudioFile');
const Segment   = require('../../domain/entities/Segment');

const SEGMENT_DURATION = 3; 

class LoadDetectionsUseCase {
  constructor({ detectionRepository, mappingService, labelRepository, speciesRepository }) {
    this._repo    = detectionRepository;
    this._mapping = mappingService;
    this._labels  = labelRepository;
    this._species = speciesRepository;
  }

  async execute({ csvPath, audioBasePath, excelPath }) {
    const safeAudioBasePath = audioBasePath ? path.normalize(audioBasePath) : null;
    const safeCsvPath = path.normalize(csvPath);

    let rawRows = [];
    const pathStat = fs.statSync(safeCsvPath);

    // FEATURE: Support BOTH batch folder scanning AND single file loading
    if (pathStat.isDirectory()) {
      console.log(`[UseCase] Scanning directory for detection tables: ${safeCsvPath}`);
      const files = fs.readdirSync(safeCsvPath);
      
      // Target both format styles inside the folder loop
      const tableFiles = files.filter(f => 
        f.endsWith('.BirdNET.selection.table.txt') || 
        f.endsWith('.csv') || 
        f.endsWith('.txt')
      );

      for (const file of tableFiles) {
        const fullTablePath = path.join(safeCsvPath, file);
        try {
          const rows = await this._repo.parseFromCsv(fullTablePath);
          rawRows = rawRows.concat(rows);
        } catch (fileErr) {
          console.warn(`[UseCase] Skipping unparseable file ${file}:`, fileErr.message);
        }
      }
    } else {
      // Fallback: Read single standalone file normally
      rawRows = await this._repo.parseFromCsv(safeCsvPath);
    }

    // Resolve absolute paths securely
    const resolvedRows = rawRows.map(row => {
      let resolvedPath = row.filePath;
      
      if (safeAudioBasePath) {
        const fileName = path.basename(row.filePath);
        const directPath = path.normalize(path.join(safeAudioBasePath, fileName));

        if (!directPath.startsWith(safeAudioBasePath)) {
          console.warn(`[Security Alert] Blocked directory traversal attempt: ${row.filePath}`);
          return { ...row, filePath: null }; 
        }

        if (fs.existsSync(directPath)) {
          resolvedPath = directPath;
        } else if (!path.isAbsolute(row.filePath)) {
          const relativePath = path.normalize(path.join(safeAudioBasePath, row.filePath));
          if (relativePath.startsWith(safeAudioBasePath) && fs.existsSync(relativePath)) {
            resolvedPath = relativePath;
          } else {
            resolvedPath = directPath;
          }
        } else {
          resolvedPath = directPath;
        }
      } else if (!path.isAbsolute(row.filePath)) {
        resolvedPath = path.normalize(path.join(safeAudioBasePath || '', row.filePath));
      }
      
      return {
        ...row,
        filePath: resolvedPath,
      };
    });

    const filteredRows = resolvedRows.filter(row => row.filePath !== null);
    const grouped = this._mapping.mapAndGroup(filteredRows);

    let existingLabels = new Map();
    if (excelPath && this._labels) {
      try {
        const safeExcelPath = path.normalize(excelPath);
        if (fs.existsSync(safeExcelPath)) {
          existingLabels = await this._labels.loadExistingLabels(safeExcelPath);
        }
      } catch (err) {
        console.warn('[LoadDetectionsUseCase] Failed to load existing labels:', err.message);
      }
    }

    const audioFiles = [];

    for (const [filePath, detections] of grouped) {
      const segments = this._buildSegments(detections, filePath, existingLabels);
      audioFiles.push(new AudioFile({ filePath, segments, detections }));
    }

    // Stable alphabetical sort by filename in sidebar menu
    audioFiles.sort((a, b) => a.fileName.localeCompare(b.fileName));

    return audioFiles;
  }

  // ─── private (kept exactly as original) ──────────────────────────────────────
  _buildSegments(detections, filePath, existingLabels) {
    // ─── FIX 1: Extract fileName from filePath ───
    const fileName = path.basename(filePath);
    
    // 1. Group the raw detections by segment index
    const byIndex = new Map();
    const SEGMENT_DURATION = 3.0; 

    // ─── FIX 2: Loop over 'detections' (the passed argument) ───
    detections.forEach(det => {
      // NOTE: Make sure 'startSeconds' matches your parsed CSV object key!
      // If your CSV parser uses 'beginTime' instead, change it to det.beginTime
      const index = Math.floor(det.startSeconds / SEGMENT_DURATION); 
      
      if (!byIndex.has(index)) {
        byIndex.set(index, []);
      }
      // Push EVERY detection for this time block into the array
      byIndex.get(index).push(det); 
    });

    const segments = [];

    // 2. Build the segments from the grouped map
    for (const [idx, dets] of byIndex.entries()) {
      // Sort from highest confidence to lowest
      const sortedDets = [...dets].sort((a, b) => b.confidence - a.confidence);
      const best = sortedDets[0]; // Primary detection
      
      const segment = new Segment({
        index:        idx,
        startSeconds: idx * SEGMENT_DURATION,
        endSeconds:   (idx + 1) * SEGMENT_DURATION,
        detection:    best,
        allDetections: sortedDets 
      });

      segment.allDetections = sortedDets;

      // fileName is now safely defined at the top of the function
      const key = `${fileName}_${idx}`;
      const existingList = existingLabels ? existingLabels.get(key) : null;
      if (existingList && existingList.length > 0) {
        const Label = require('../../domain/entities/Label');
        existingList.forEach(existing => {
          const specificDet = sortedDets.find(d => d.labId === existing.speciesLabId) || best;
          
          const label = new Label({
            audioFileName:         fileName,
            audioFilePath:         filePath,
            segmentIndex:          idx,
            startSeconds:          idx * SEGMENT_DURATION,
            endSeconds:            (idx + 1) * SEGMENT_DURATION,
            speciesLabId:          existing.speciesLabId,
            speciesChineseName:    existing.speciesChineseName,
            speciesEnglishName:    existing.speciesEnglishName,
            speciesScientificName: existing.speciesScientificName,
            detectedEBirdCode:     specificDet.ebirdCode || '',
            detectedConfidence:    specificDet.confidence || 0,
            labelValue:            existing.labelValue,
            notes:                 existing.notes,
            reviewer:              existing.reviewer,
            timestamp:             existing.timestamp,
          });
          segment.confirm(label);
        });
      }

      segments.push(segment);
    }
    return segments.sort((a, b) => a.index - b.index);
  }
}

module.exports = LoadDetectionsUseCase;