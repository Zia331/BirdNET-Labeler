'use strict';

class Segment {
  constructor({ index, startSeconds, endSeconds, detection = null, allDetections = [], labels = {} }) {
    this.index         = index;
    this.startSeconds  = startSeconds;
    this.endSeconds    = endSeconds;
    this.detection     = detection;
    this.allDetections = allDetections; 
    
    // ─── NEW: Store multiple labels keyed by speciesLabId ───
    this.labels        = labels; 
  }

  get duration()   { return this.endSeconds - this.startSeconds; }
  get isDetected() { return this.detection !== null; }

  // ─── NEW: Only returns true if EVERY detected species has a saved label ───
  get isLabeled() {
    if (this.allDetections.length === 0) return Object.keys(this.labels).length > 0;
    return this.allDetections.every(d => this.labels[d.labId] !== undefined);
  }

  confirm(label) {
    if (!label || typeof label.audioFilePath !== 'string') {
      throw new Error('Segment.confirm() requires a Label-shaped object');
    }
    // Save to dictionary instead of overwriting a single property
    this.labels[label.speciesLabId] = label;
  }
}

module.exports = Segment;