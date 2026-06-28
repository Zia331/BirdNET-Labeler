'use strict';

/**
 * @domain entities
 *
 * A single BirdNET detection record that has been mapped to the lab's
 * species ID system. One Detection corresponds to one 3-second BirdNET window.
 */
class Detection {
  /**
   * @param {object} props
   * @param {string} props.ebirdCode      - Raw eBird species code from BirdNET CSV
   * @param {string|null} props.labId     - Mapped lab ID (null if unmapped)
   * @param {string} props.scientificName
   * @param {string} props.chineseName
   * @param {string} props.englishName
   * @param {number} props.confidence     - [0, 1]
   * @param {number} props.startSeconds
   * @param {number} props.endSeconds
   */
  constructor({
    ebirdCode,
    labId = null,
    scientificName = '',
    chineseName = '',
    englishName = '',
    confidence,
    startSeconds,
    endSeconds,
  }) {
    this.ebirdCode      = ebirdCode;
    this.labId          = labId;
    this.scientificName = scientificName;
    this.chineseName    = chineseName;
    this.englishName    = englishName;
    this.confidence     = confidence;
    this.startSeconds   = startSeconds;
    this.endSeconds     = endSeconds;
    Object.freeze(this);
  }

  get isMapped() { return this.labId !== null; }

  /** Zero-based segment index this detection falls in (BirdNET segments = 3 s). */
  get segmentIndex() { return Math.floor(this.startSeconds / 3); }
}

module.exports = Detection;
