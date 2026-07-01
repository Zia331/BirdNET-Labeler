const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const AudioFilenameMetadataService = require("../src/domain/services/AudioFilenameMetadataService");

test("parses site and timestamp from filenames with device serial", () => {
  const service = new AudioFilenameMetadataService({
    sitesCsvPath: path.join(__dirname, "..", "resources", "sites.csv"),
  });

  const result = service.parse(
    "sp1L1_102_105_TW_BRCAS_PDSL01_S4A08263_20190111_140000.wav",
  );

  assert.deepEqual(result, {
    siteCode: "PDSL01",
    siteName: "雙流",
    recordedTime: "2019-01-11 14:00:00",
  });
});

test("parses site and timestamp when device serial is absent", () => {
  const service = new AudioFilenameMetadataService({
    sitesCsvPath: path.join(__dirname, "..", "resources", "sites.csv"),
  });

  const result = service.parse("initial_YLSLP_20240220_150000.wav");

  assert.deepEqual(result, {
    siteCode: "YLSLP",
    siteName: "宜蘭雙連埤",
    recordedTime: "2024-02-20 15:00:00",
  });
});

test("falls back to the raw site code if it is not mapped", () => {
  const service = new AudioFilenameMetadataService({
    sitesCsvPath: path.join(__dirname, "..", "resources", "sites.csv"),
  });

  const result = service.parse("foo_UNKNOWN_20240220_150000.wav");

  assert.deepEqual(result, {
    siteCode: "UNKNOWN",
    siteName: "UNKNOWN",
    recordedTime: "2024-02-20 15:00:00",
  });
});
