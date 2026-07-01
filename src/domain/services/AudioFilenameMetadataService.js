"use strict";

const fs = require("fs");
const path = require("path");

class AudioFilenameMetadataService {
  constructor({ sitesCsvPath }) {
    this.sitesCsvPath = sitesCsvPath;
    this._siteMap = this._loadSiteMap(sitesCsvPath);
  }

  parse(fileName) {
    const baseName = path.basename(fileName || "").replace(/\.[^.]+$/, "");
    if (!baseName) {
      return { siteCode: "", siteName: "", recordedTime: "" };
    }

    const parts = baseName.split("_").filter(Boolean);
    if (parts.length < 3) {
      return { siteCode: baseName, siteName: baseName, recordedTime: "" };
    }

    const hasSerial = parts[parts.length - 3]?.startsWith("S4A");
    const dateToken = parts[parts.length - 2];
    const timeToken = parts[parts.length - 1];
    const siteIndex = hasSerial ? parts.length - 4 : parts.length - 3;
    const siteCode = parts[siteIndex] || baseName;

    const recordedTime = this._formatRecordedTime(dateToken, timeToken);
    const siteName = this._siteMap.get(siteCode) || siteCode;

    return {
      siteCode,
      siteName,
      recordedTime,
    };
  }

  _loadSiteMap(sitesCsvPath) {
    const map = new Map();
    if (!sitesCsvPath) return map;

    try {
      const raw = fs.readFileSync(sitesCsvPath, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      for (const line of lines.slice(1)) {
        const [site, fullSiteName] = line.split(",");
        if (site && fullSiteName) {
          map.set(site.trim(), fullSiteName.trim());
        }
      }
    } catch (err) {
      console.warn(
        "[AudioFilenameMetadataService] Unable to load sites.csv:",
        err.message,
      );
    }

    return map;
  }

  _formatRecordedTime(dateToken, timeToken) {
    if (
      !dateToken ||
      !timeToken ||
      dateToken.length !== 8 ||
      timeToken.length !== 6
    ) {
      return "";
    }

    return `${dateToken.slice(0, 4)}-${dateToken.slice(4, 6)}-${dateToken.slice(6, 8)} ${timeToken.slice(0, 2)}:${timeToken.slice(2, 4)}:${timeToken.slice(4, 6)}`;
  }
}

module.exports = AudioFilenameMetadataService;
