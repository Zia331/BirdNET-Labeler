'use strict';

/**
 * @domain repositories
 *
 * Interface contracts for the three repositories. Infrastructure layer
 * provides concrete implementations; domain/application layers only depend
 * on these shapes (duck-typed in JS — treat as documentation + lint aid).
 */

/**
 * ISpeciesRepository — read-only lookup of lab species data.
 *
 * @interface
 * @method {Species|null}  findByLabId(labId: string)
 * @method {Species|null}  findByEBirdCode(ebirdCode: string)
 * @method {Species[]}     findAll()
 */
class ISpeciesRepository {}

/**
 * IDetectionRepository — reads BirdNET output files.
 *
 * @interface
 * @method {Promise<RawDetectionRow[]>} parseFromCsv(csvPath: string)
 *   where RawDetectionRow = { speciesCode, startSeconds, endSeconds, confidence, filePath? }
 */
class IDetectionRepository {}

/**
 * ILabelRepository — persists confirmed labels.
 *
 * @interface
 * @method {Promise<void>} save(label: Label)           — append one label
 * @method {void}          setOutputPath(filePath: string)
 * @method {string|null}   getOutputPath()
 */
class ILabelRepository {}

module.exports = { ISpeciesRepository, IDetectionRepository, ILabelRepository };
