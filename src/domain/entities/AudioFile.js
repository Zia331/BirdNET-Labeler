'use strict';

const path = require('path');

/**
 * @domain entities
 *
 * Represents one audio clip (≤ 9 s) together with its BirdNET detections
 * and the labeler's progress across its segments.
 */
class AudioFile {
  /**
   * @param {object}      props
   * @param {string}      props.filePath      - Absolute path (also serves as aggregate ID)
   * @param {Segment[]}   props.segments      - Ordered list of 3-second segments
   * @param {Detection[]} props.detections    - All raw detections for this file
   * @param {number|null} props.durationSeconds - Set after the audio is decoded in the renderer
   */
  constructor({ filePath, segments = [], detections = [], durationSeconds = null }) {
    this.filePath         = filePath;
    this.segments         = segments;
    this.detections       = detections;
    this.durationSeconds  = durationSeconds;
  }

  /** Primary key / aggregate root ID. */
  get id()       { return this.filePath; }
  get fileName() { return path.basename(this.filePath); }

  get totalSegments()     { return this.segments.length; }
  get labeledSegments()   { return this.segments.filter(s => s.isLabeled).length; }
  get isFullyLabeled()    { return this.labeledSegments === this.totalSegments; }
  get progressPercent()   { return this.totalSegments === 0 ? 0 : Math.round(this.labeledSegments / this.totalSegments * 100); }

  /** Segment boundaries that need dotted-line markers on the spectrogram. */
  get segmentBoundaries() {
    return this.segments
      .slice(1)                            // skip the first (no boundary before segment 0)
      .map(s => s.startSeconds);
  }

  segmentAt(index) {
    return this.segments.find(s => s.index === index) ?? null;
  }
}

module.exports = AudioFile;
