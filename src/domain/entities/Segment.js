'use strict';

/**
 * @domain entities
 *
 * A 3-second slice of an audio file. BirdNET operates on these slices;
 * a labeler must confirm or override one label per segment.
 */
class Segment {
  /**
   * @param {object}         props
   * @param {number}         props.index        - 0-based (0 = 0–3 s, 1 = 3–6 s, 2 = 6–9 s)
   * @param {number}         props.startSeconds
   * @param {number}         props.endSeconds
   * @param {Detection|null} props.detection    - Best-ranked BirdNET detection for this window
   * @param {Label|null}     props.label        - Set once the reviewer confirms
   */
  constructor({ index, startSeconds, endSeconds, detection = null, label = null }) {
    this.index        = index;
    this.startSeconds = startSeconds;
    this.endSeconds   = endSeconds;
    this.detection    = detection;
    this.label        = label;  // intentionally mutable
  }

  get duration()   { return this.endSeconds - this.startSeconds; }
  get isLabeled()  { return this.label !== null; }
  get isDetected() { return this.detection !== null; }

  /**
   * Attach a confirmed label.
   * Uses duck-typing to avoid a circular require on Label.js.
   * @param {Label} label
   */
  confirm(label) {
    if (!label || typeof label.audioFilePath !== 'string') {
      throw new Error('Segment.confirm() requires a Label-shaped object');
    }
    this.label = label;
  }
}

module.exports = Segment;
