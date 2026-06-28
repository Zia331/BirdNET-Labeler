'use strict';

const Species = require('../../domain/entities/Species');

/**
 * @infrastructure species
 *
 * Loads speciesDict.json (the JS-side equivalent of speciesDict.py) and
 * exposes fast O(1) lookups by labId or eBird code.
 *
 * Expected JSON shape (mirrors the Python dicts):
 * {
 *   "ebird_to_id":      { "<ebirdCode>": "<labId>", ... },
 *   "id_to_chinese":    { "<labId>": "<chineseName>", ... },
 *   "id_to_english":    { "<labId>": "<englishName>", ... },
 *   "id_to_scientific": { "<labId>": "<scientificName>", ... }
 * }
 */
class InMemorySpeciesRepository {
  constructor() {
    this._byLabId    = new Map();
    this._byEbirdCode = new Map();
    this._byScientificName = new Map();
    this._byEnglishName = new Map();
    this._all        = [];
  }

  /**
   * Populate from the parsed JSON of speciesDict.json.
   * Call this once during app startup (in main.js before any handler fires).
   *
   * @param {object} dict - parsed JSON (see above)
   */
  loadFromDict(dict) {
    const {
      ebird_to_id      = {},
      id_to_chinese    = {},
      id_to_english    = {},
      id_to_scientific = {},
    } = dict;

    // Build a reverse map: labId → ebirdCode
    const idToEbird = {};
    for (const [ebird, id] of Object.entries(ebird_to_id)) {
      idToEbird[id] = ebird;
    }

    // Build Species objects indexed by labId
    for (const [labId, chineseName] of Object.entries(id_to_chinese)) {
      const species = new Species({
        labId,
        chineseName,
        englishName:    id_to_english[labId]    ?? '',
        scientificName: id_to_scientific[labId] ?? '',
        ebirdCode:      idToEbird[labId]         ?? '',
      });
      this._byLabId.set(labId, species);
      if (species.ebirdCode) this._byEbirdCode.set(species.ebirdCode, species);
      if (species.scientificName) this._byScientificName.set(species.scientificName.toLowerCase(), species);
      if (species.englishName) this._byEnglishName.set(species.englishName.toLowerCase(), species);
      this._all.push(species);
    }

    // Register sentinels
    for (const sentinel of [Species.BACKGROUND, Species.UNKNOWN]) {
      this._byLabId.set(sentinel.labId, sentinel);
      this._all.unshift(sentinel); // show at top of dropdown
    }
  }

  /** @returns {Species|null} */
  findByLabId(labId)        { return this._byLabId.get(labId) ?? null; }

  /** @returns {Species|null} */
  findByEBirdCode(ebirdCode){ return this._byEbirdCode.get(ebirdCode) ?? null; }

  /** @returns {Species|null} */
  findByScientificName(scientificName) {
    if (!scientificName) return null;
    return this._byScientificName.get(scientificName.toLowerCase()) ?? null;
  }

  /** @returns {Species|null} */
  findByEnglishName(englishName) {
    if (!englishName) return null;
    return this._byEnglishName.get(englishName.toLowerCase()) ?? null;
  }

  /** @returns {Species[]} — sentinels first, then sorted by chineseName */
  findAll() { return this._all; }
}

module.exports = InMemorySpeciesRepository;
