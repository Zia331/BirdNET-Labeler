"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

// ── Infrastructure ────────────────────────────────────────────────────────────
const AppStore = require("./src/infrastructure/persistence/AppStore");
const BirdNetCsvRepository = require("./src/infrastructure/csv/BirdNetCsvRepository");
const ExcelJsLabelRepository = require("./src/infrastructure/excel/ExcelJsLabelRepository");
const InMemorySpeciesRepository = require("./src/infrastructure/species/InMemorySpeciesRepository");

// ── Domain ────────────────────────────────────────────────────────────────────
const DetectionMappingService = require("./src/domain/services/DetectionMappingService");
const AudioFilenameMetadataService = require("./src/domain/services/AudioFilenameMetadataService");

// ── Application ───────────────────────────────────────────────────────────────
const LoadDetectionsUseCase = require("./src/application/use-cases/LoadDetectionsUseCase");
const ConfirmSegmentLabelUseCase = require("./src/application/use-cases/ConfirmSegmentLabelUseCase");

// ── Presentation ──────────────────────────────────────────────────────────────
const { registerIpcHandlers } = require("./src/presentation/ipc/handlers");

// ─── Compose the dependency graph ─────────────────────────────────────────────
const speciesRepository = new InMemorySpeciesRepository();

// SECURITY: Normalize internal asset paths defensively
const dictPath = path.normalize(
  path.join(__dirname, "resources", "speciesDict.json"),
);

if (fs.existsSync(dictPath)) {
  const dict = JSON.parse(fs.readFileSync(dictPath, "utf8"));
  speciesRepository.loadFromDict(dict);
  console.log(
    "[main] species dict loaded:",
    Object.keys(dict.ebird_to_id ?? {}).length,
    "eBird codes",
  );
} else {
  console.warn(
    "[main] resources/speciesDict.json not found — run scripts/convert_species_dict.py first.",
  );
}

const csvRepository = new BirdNetCsvRepository();
const labelRepository = new ExcelJsLabelRepository();
const mappingService = new DetectionMappingService(speciesRepository);
const audioFilenameMetadataService = new AudioFilenameMetadataService({
  sitesCsvPath: path.join(__dirname, "resources", "sites.csv"),
});

const loadDetectionsUseCase = new LoadDetectionsUseCase({
  detectionRepository: csvRepository,
  mappingService,
  labelRepository,
  speciesRepository,
  audioFilenameMetadataService,
});

const confirmSegmentLabelUseCase = new ConfirmSegmentLabelUseCase({
  labelRepository,
  speciesRepository,
});

const audioFileStore = new Map();

// ─── Electron lifecycle ───────────────────────────────────────────────────────

// Moved to file scope so the fs.watch live reloader can access it without a ReferenceError
let mainWindow;

function createWindow() {
  const iconPath = path.join(__dirname, "resources", "noun-bird-1711226.png");
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 920,
    minHeight: 620,
    title: "BirdNET Labeler",
    icon: iconPath,
    backgroundColor: "#12121e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(
    path.join(__dirname, "src/presentation/renderer/index.html"),
  );

  if (process.argv.includes("--devtools")) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  const appStore = new AppStore();

  const savedOutputPath = appStore.getOutputPath();
  if (savedOutputPath) {
    // SECURITY NOTE: Ensure within `ExcelJsLabelRepository` that `savedOutputPath`
    // is normalized and checked before any file writes occur.
    const safePath = path.normalize(savedOutputPath);
    labelRepository.setOutputPath(safePath);
    console.log("[main] restored output path:", safePath);
  }

  registerIpcHandlers({
    loadDetectionsUseCase,
    confirmSegmentLabelUseCase,
    speciesRepository,
    labelRepository,
    appStore,
    audioFileStore,
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // FIX: Handled the scoping issue for live reloading
  fs.watch(__dirname, { recursive: true }, (eventType, filename) => {
    if (
      filename &&
      (filename.endsWith(".html") ||
        filename.endsWith(".css") ||
        filename.endsWith(".js"))
    ) {
      if (filename !== "main.js" && mainWindow) {
        mainWindow.reload();
      }
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
