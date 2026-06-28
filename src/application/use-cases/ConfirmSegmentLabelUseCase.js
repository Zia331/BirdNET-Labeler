'use strict';

const Label = require('../../domain/entities/Label');

/**
 * @application use-cases
 *
 * Called when the reviewer clicks "Confirm" on a segment.
 *  1. Creates a Label entity from the reviewer's input.
 *  2. Mutates the segment (segment.label = label).
 *  3. Persists the label immediately to the Excel output file.
 *
 * The "save on every confirm" design keeps data safe even if the
 * app crashes mid-session.
 */
class ConfirmSegmentLabelUseCase {
  /**
   * @param {object} deps
   * @param {ILabelRepository}  deps.labelRepository
   * @param {ISpeciesRepository} deps.speciesRepository
   */
  constructor({ labelRepository, speciesRepository }) {
    this._labels  = labelRepository;
    this._species = speciesRepository;
  }

  /**
   * @param {object}    command
   * @param {AudioFile} command.audioFile
   * @param {Segment}   command.segment
   * @param {string}    command.speciesLabId   - selected lab ID (may differ from detection)
   * @param {string}    [command.notes]
   * @param {string}    [command.reviewer]
   * @param {string}    [command.labelValue]   - "TP" or "FP"
   * @returns {Promise<Label>}
   */
  async execute({ audioFile, segment, speciesLabId, notes = '', reviewer = '', labelValue = 'TP' }) {
    const species = this._species.findByLabId(speciesLabId);

    const label = new Label({
      audioFileName:        audioFile.fileName,
      audioFilePath:        audioFile.filePath,
      segmentIndex:         segment.index,
      startSeconds:         segment.startSeconds,
      endSeconds:           segment.endSeconds,
      speciesLabId:         speciesLabId,
      speciesChineseName:   species?.chineseName    ?? speciesLabId,
      speciesEnglishName:   species?.englishName    ?? '',
      speciesScientificName:species?.scientificName ?? '',
      detectedEBirdCode:    segment.detection?.ebirdCode   ?? '',
      detectedConfidence:   segment.detection?.confidence  ?? 0,
      labelValue,
      notes,
      reviewer,
      timestamp: new Date(),
    });

    segment.confirm(label);                // update in-memory domain state
    await this._labels.save(label);        // persist immediately

    return label;
  }
}

module.exports = ConfirmSegmentLabelUseCase;
