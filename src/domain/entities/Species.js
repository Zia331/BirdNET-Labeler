'use strict';

/**
 * @domain entities
 *
 * Represents a bird species with all identifier systems used across the lab.
 */
class Species {
  /**
   * @param {object} props
   * @param {string} props.labId          - Internal lab identifier (primary key)
   * @param {string} props.chineseName    - Traditional Chinese name
   * @param {string} props.englishName    - Common English name
   * @param {string} props.scientificName - Binomial scientific name
   * @param {string} props.ebirdCode      - eBird 6-letter species code (used by BirdNET)
   */
  constructor({ labId, chineseName, englishName, scientificName, ebirdCode }) {
    this.labId          = labId;
    this.chineseName    = chineseName;
    this.englishName    = englishName;
    this.scientificName = scientificName;
    this.ebirdCode      = ebirdCode;
    Object.freeze(this);
  }

  /** Display string for the species picker. */
  get displayLabel() {
    return `${this.chineseName} / ${this.englishName} (${this.scientificName}) [${this.labId}]`;
  }
}

// Sentinel species for non-bird segments
Species.BACKGROUND = new Species({
  labId: 'BACKGROUND',
  chineseName: '背景聲',
  englishName: 'Background / Non-bird',
  scientificName: '-',
  ebirdCode: '',
});

Species.UNKNOWN = new Species({
  labId: 'UNKNOWN',
  chineseName: '未知',
  englishName: 'Unknown',
  scientificName: '-',
  ebirdCode: '',
});

module.exports = Species;
