'use strict';

/**
 * @domain entities
 *
 * A confirmed human label for one 3-second segment of an audio file.
 * Immutable after construction — mutating requires creating a new instance.
 */
class Label {
  /**
   * @param {object} props
   * @param {string}  props.audioFileName      - basename of the source audio file
   * @param {string}  props.audioFilePath      - full path (also used as AudioFile.id)
   * @param {number}  props.segmentIndex       - 0-based segment index
   * @param {number}  props.startSeconds
   * @param {number}  props.endSeconds
   * @param {string|null} props.speciesLabId   - lab-internal species ID; null = background/unknown
   * @param {string}  props.speciesChineseName
   * @param {string}  props.speciesEnglishName
   * @param {string}  props.speciesScientificName
   * @param {string}  props.detectedEBirdCode  - BirdNET's original eBird code (may differ from confirmed)
   * @param {number}  props.detectedConfidence - BirdNET confidence [0-1]
   * @param {string}  props.labelValue         - "TP" or "FP"
   * @param {string}  props.notes
   * @param {string}  props.reviewer
   * @param {Date}    props.timestamp
   */
  constructor({
    audioFileName,
    audioFilePath,
    segmentIndex,
    startSeconds,
    endSeconds,
    speciesLabId = null,
    speciesChineseName = '',
    speciesEnglishName = '',
    speciesScientificName = '',
    detectedEBirdCode = '',
    detectedConfidence = 0,
    labelValue = 'TP',
    notes = '',
    reviewer = '',
    timestamp = new Date(),
  }) {
    this.audioFileName       = audioFileName;
    this.audioFilePath       = audioFilePath;
    this.segmentIndex        = segmentIndex;
    this.startSeconds        = startSeconds;
    this.endSeconds          = endSeconds;
    this.speciesLabId        = speciesLabId;
    this.speciesChineseName  = speciesChineseName;
    this.speciesEnglishName  = speciesEnglishName;
    this.speciesScientificName = speciesScientificName;
    this.detectedEBirdCode   = detectedEBirdCode;
    this.detectedConfidence  = detectedConfidence;
    this.labelValue          = labelValue;
    this.notes               = notes;
    this.reviewer            = reviewer;
    this.timestamp           = timestamp instanceof Date ? timestamp : new Date(timestamp);
 
    Object.freeze(this);
  }

  /** True if this label represents a confirmed bird detection (not background/unknown). */
  get isBird() {
    return this.speciesLabId !== null
      && this.speciesLabId !== 'BACKGROUND'
      && this.speciesLabId !== 'UNKNOWN';
  }
}

module.exports = Label;
