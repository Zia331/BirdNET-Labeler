"use strict";

const { ipcMain, dialog } = require("electron");
const fs = require("fs");
const path = require("path");

const CHANNELS = require("./channels");

/**
 * @presentation ipc
 */
function registerIpcHandlers({
  loadDetectionsUseCase,
  confirmSegmentLabelUseCase,
  speciesRepository,
  labelRepository,
  appStore,
  audioFileStore,
}) {
  // ── Dialogs ──────────────────────────────────────────────────────────────────

  ipcMain.handle(CHANNELS.OPEN_CSV_DIALOG, async () => {
    const lastCsv = appStore.getLastCsvPath();
    let defaultPath;
    if (lastCsv) {
      try {
        defaultPath = fs.statSync(lastCsv).isDirectory()
          ? lastCsv
          : path.dirname(lastCsv);
      } catch {
        defaultPath = undefined;
      }
    }

    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Select Folder Containing BirdNET Tables & Audio",
      defaultPath,
      properties: ["openDirectory"],
    });

    if (canceled || filePaths.length === 0) return null;

    const baseDir = filePaths[0];
    appStore.setLastCsvPath(baseDir);
    appStore.setLastAudioPath(baseDir);

    // Return the folder path as the csvPath item so the UseCase knows where to scan
    return {
      csvPath: baseDir,
      audioBasePath: baseDir,
    };
  });

  // Keep as a fallback option or remove if unused by the updated UI
  ipcMain.handle(CHANNELS.OPEN_AUDIO_DIALOG, async () => {
    const lastAudio = appStore.getLastAudioPath();
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Select Audio Directory",
      defaultPath: lastAudio ?? undefined,
      properties: ["openDirectory"],
    });
    if (canceled) return null;
    appStore.setLastAudioPath(filePaths[0]);
    return filePaths[0];
  });

  ipcMain.handle(CHANNELS.OPEN_EXCEL_DIALOG, async () => {
    const current = appStore.getOutputPath();
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Set Output Excel File",
      defaultPath: current ?? "labels.xlsx",
      filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
    });
    return canceled ? null : filePath;
  });

  // ── Detections ────────────────────────────────────────────────────────────────

  ipcMain.handle(CHANNELS.LOAD_DETECTIONS, async (_e, payload) => {
    // Destructure the object sent by preload.js safely
    const { csvPath, audioBasePath } = payload || {};

    if (!csvPath) throw new Error("Missing csvPath parameter.");

    const stat = fs.statSync(csvPath);
    let folderName = stat.isDirectory()
      ? path.basename(csvPath)
      : path.basename(path.dirname(csvPath));
    const parentDir = stat.isDirectory() ? csvPath : path.dirname(csvPath);
    const excelPath = path.join(parentDir, `labeled_${folderName}.xlsx`);

    labelRepository.setOutputPath(excelPath);

    const audioFiles = await loadDetectionsUseCase.execute({
      csvPath,
      audioBasePath,
      excelPath,
    });

    audioFileStore.clear();
    for (const af of audioFiles) audioFileStore.set(af.id, af);

    return audioFiles.map(toAudioFileDto);
  });

  // ── Audio ─────────────────────────────────────────────────────────────────────

  ipcMain.handle(CHANNELS.READ_AUDIO, async (_e, payload) => {
    // Destructure the audioPath out of the object sent by preload.js
    const { audioPath } = payload || {};

    if (!audioPath) throw new Error("Missing audioPath parameter.");

    const buf = fs.readFileSync(audioPath);
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    return ab;
  });

  // ── Species ───────────────────────────────────────────────────────────────────

  ipcMain.handle(CHANNELS.GET_ALL_SPECIES, () =>
    speciesRepository.findAll().map((s) => ({
      labId: s.labId,
      chineseName: s.chineseName,
      englishName: s.englishName,
      scientificName: s.scientificName,
      ebirdCode: s.ebirdCode,
      displayLabel: s.displayLabel,
    })),
  );

  // ── Labels ────────────────────────────────────────────────────────────────────

  ipcMain.handle(CHANNELS.SET_OUTPUT_PATH, (_e, args) => {
    const filePath =
      typeof args === "object" && args !== null ? args.filePath : args;
    labelRepository.setOutputPath(filePath);
    appStore.setOutputPath(filePath);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.GET_OUTPUT_PATH, () => {
    const stored = appStore.getOutputPath();
    if (stored && !labelRepository.getOutputPath()) {
      labelRepository.setOutputPath(stored);
    }
    return labelRepository.getOutputPath();
  });

  ipcMain.handle(CHANNELS.SAVE_LABEL, async (_e, dto) => {
    const audioFile = audioFileStore.get(dto.audioFilePath);
    if (!audioFile) {
      throw new Error(
        `AudioFile not found in session store: ${dto.audioFilePath}\n` +
          `Make sure the CSV was loaded before confirming labels.`,
      );
    }

    const segment = audioFile.segmentAt(dto.segmentIndex);
    if (!segment) {
      throw new Error(
        `Segment ${dto.segmentIndex} not found in ${audioFile.fileName}`,
      );
    }

    const label = await confirmSegmentLabelUseCase.execute({
      audioFile,
      segment,
      speciesLabId: dto.speciesLabId,
      notes: dto.notes ?? "",
      reviewer: dto.reviewer ?? "",
      labelValue: dto.labelValue ?? "True",
    });

    return { ok: true, labelTimestamp: label.timestamp.toISOString() };
  });

  // ── Settings ──────────────────────────────────────────────────────────────────

  ipcMain.handle(CHANNELS.GET_REVIEWER, () => appStore.getReviewer());

  ipcMain.handle(CHANNELS.SET_REVIEWER, (_e, args) => {
    const name = typeof args === "object" && args !== null ? args.name : args;
    appStore.setReviewer(name);
    return { ok: true };
  });
}

function toAudioFileDto(af) {
  return {
    id: af.id,
    filePath: af.filePath,
    fileName: af.fileName,
    segmentBoundaries: af.segmentBoundaries,
    metadata: af.metadata || { siteCode: "", siteName: "", recordedTime: "" },
    segments: af.segments.map((s) => {
      // Convert the labels map into a safe JSON object for the frontend
      const safeLabels = {};
      for (const [spId, lbl] of Object.entries(s.labels)) {
        safeLabels[spId] = {
          speciesLabId: lbl.speciesLabId,
          labelValue: lbl.labelValue,
          notes: lbl.notes,
          reviewer: lbl.reviewer,
        };
      }

      return {
        index: s.index,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        isLabeled: s.isLabeled, // Now strictly true ONLY if all are labeled
        labels: safeLabels, // Send the dictionary
        detection: s.detection
          ? {
              ebirdCode: s.detection.ebirdCode,
              labId: s.detection.labId,
              chineseName: s.detection.chineseName,
              englishName: s.detection.englishName,
              scientificName: s.detection.scientificName,
              confidence: s.detection.confidence,
            }
          : null,
        allDetections: (s.allDetections || []).map((d) => ({
          ebirdCode: d.ebirdCode,
          labId: d.labId,
          chineseName: d.chineseName,
          englishName: d.englishName,
          scientificName: d.scientificName,
          confidence: d.confidence,
        })),
      };
    }),
  };
}

module.exports = { registerIpcHandlers };
