'use strict';

const Detection = require('../entities/Detection');

/**
 * @domain services
 *
 * Translates raw BirdNET detection rows (which use eBird species codes)
 * into domain Detection objects that carry the lab's internal IDs and
 * Chinese/English/scientific names.
 */
class DetectionMappingService {
  /** @param {ISpeciesRepository} speciesRepository */
  constructor(speciesRepository) {
    this._species = speciesRepository;
  }

  /**
   * Map one raw CSV row to a Detection entity.
   *
   * @param {object} row
   * @param {string} row.speciesCode   - eBird 6-letter code from BirdNET CSV
   * @param {number} row.confidence
   * @param {number} row.startSeconds
   * @param {number} row.endSeconds
   * @returns {Detection}  labId is null when the eBird code is not in the species dict
   */
  map(row) {
    let species = this._species.findByEBirdCode(row.speciesCode);
    if (!species) {
      species = this._species.findByScientificName(row.speciesCode);
    }
    if (!species) {
      species = this._species.findByEnglishName(row.speciesCode);
    }

    return new Detection({
      ebirdCode:      species?.ebirdCode      ?? row.speciesCode,
      labId:          species?.labId          ?? null,
      chineseName:    species?.chineseName    ?? '',
      englishName:    species?.englishName    ?? '',
      scientificName: species?.scientificName ?? '',
      confidence:     row.confidence,
      startSeconds:   row.startSeconds,
      endSeconds:     row.endSeconds,
    });
  }

  /**
   * Map an array of raw rows and group them by absolute audio file path.
   *
   * @param {object[]} rows   - as returned by BirdNetCsvRepository
   * @returns {Map<string, Detection[]>}  key = absolute audio path
   */
  mapAndGroup(rows) {
    const grouped = new Map();

    for (const row of rows) {
      const key = row.filePath;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(this.map(row));
    }

    return grouped;
  }
}

module.exports = DetectionMappingService;
