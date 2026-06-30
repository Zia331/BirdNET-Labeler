'use strict';

const ExcelJS = require('exceljs');
const fs      = require('fs');

const SHEET_NAME = 'Labels';

const COLUMNS = [
  { header: 'filename',             width: 30 }, // Column 1 (A)
  { header: 'segment_index',        width: 10 }, // Column 2 (B)
  { header: 'start_time',           width: 10 }, // Column 3 (C)
  { header: 'end_time',             width: 10 }, // Column 4 (D)
  { header: 'species_id',           width: 14 }, // Column 5 (E)
  { header: 'chinese_common_name',   width: 18 }, // Column 6 (F)
  { header: 'english_common_name',   width: 28 }, // Column 7 (G)
  { header: 'scientific_name',       width: 30 }, // Column 8 (H)
  { header: 'ebird_code',           width: 14 }, // Column 9 (I)
  { header: 'confidence',           width: 14 }, // Column 10 (J)
  { header: 'label',                width: 10 }, // Column 11 (K)
  { header: 'notes',                 width: 24 }, // Column 12 (L)
  { header: 'reviewer',              width: 14 }, // Column 13 (M)
  { header: 'modified_at',          width: 22 }, // Column 14 (N)
];

function toLocalISOString(date) {
  const tzo = -date.getTimezoneOffset();
  const dif = tzo >= 0 ? '+' : '-';
  const pad = (num) => String(num).padStart(2, '0');
  const padMs = (num) => String(num).padStart(3, '0');
  
  return date.getFullYear() +
    '-' + pad(date.getMonth() + 1) +
    '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) +
    ':' + pad(date.getMinutes()) +
    ':' + pad(date.getSeconds()) +
    '.' + padMs(date.getMilliseconds()) +
    '+08:00';
}

class ExcelJsLabelRepository {
  constructor() {
    this._outputPath = null;
  }

  setOutputPath(filePath) { this._outputPath = filePath; }
  getOutputPath()         { return this._outputPath; }

  async save(label) {
    if (!this._outputPath) {
      throw new Error('ExcelJsLabelRepository: output path is not set.');
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator  = 'BirdNET-Labeler';
    workbook.modified = new Date();

    let worksheet;
    let isNew = false;

    // 1. Read existing file or create a fresh one
    if (fs.existsSync(this._outputPath)) {
      try {
        await workbook.xlsx.readFile(this._outputPath);
        worksheet = workbook.getWorksheet(SHEET_NAME);
        if (!worksheet) {
          worksheet = workbook.addWorksheet(SHEET_NAME);
          isNew = true;
        }
      } catch (err) {
        worksheet = workbook.addWorksheet(SHEET_NAME);
        isNew = true;
      }
    } else {
      worksheet = workbook.addWorksheet(SHEET_NAME);
      isNew = true;
    }

    // Only initialize layout structure if the sheet is brand new!
    if (isNew) {
      this._initSheet(worksheet);
    }

    // 2. Scan lines using explicit numeric indices (1-based for cells)
    const matchKey = `${label.audioFileName}_${label.segmentIndex}_${label.speciesLabId}`;
    let duplicateRowNumber = -1;

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip headers
      
      const rowFile = row.getCell(1).value;  
      const rowIndex = parseInt(row.getCell(2).value, 10); 
      const rowSpeciesId = row.getCell(5).value;
      const currentKey = `${rowFile}_${rowIndex}_${rowSpeciesId}`;
      
      if (currentKey === matchKey) {
        duplicateRowNumber = rowNumber;
      }
    });

    // 3. Map values purely (0-indexed array automatically maps to Columns A, B, C...)
    // FIX: Removed the leading `null`. array[0] maps perfectly to Column 1 (A).
    const rowValuesArray = [
      label.audioFileName,
      label.segmentIndex,
      label.startSeconds,
      label.endSeconds,
      label.speciesLabId ?? '',
      label.speciesChineseName ?? '',
      label.speciesEnglishName ?? '',
      label.speciesScientificName ?? '',
      label.detectedEBirdCode ?? '',
      label.detectedConfidence ? parseFloat(label.detectedConfidence.toFixed(4)) : 0,
      label.labelValue,
      label.notes ?? '',
      label.reviewer ?? '',
      toLocalISOString(label.timestamp),
    ];

    if (duplicateRowNumber !== -1) {
      // Update entry in place if modified
      const row = worksheet.getRow(duplicateRowNumber);
      row.values = rowValuesArray;
      // FIX: Removed row.commit() - it's for the streaming API and throws here.
      console.log(`[ExcelRepository] Updated row ${duplicateRowNumber} for ${matchKey}`);
    } else {
      // FIX: Use addRow to safely append to the bottom of the sheet.
      const newRow = worksheet.addRow(rowValuesArray);
      console.log(`[ExcelRepository] Appended row ${newRow.number} for ${matchKey}`);
    }

    // 4. Force write to disk storage safely
    await workbook.xlsx.writeFile(this._outputPath);
  }

  async loadExistingLabels(excelPath) {
    if (!fs.existsSync(excelPath)) return new Map();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(excelPath);
    const worksheet = workbook.getWorksheet(SHEET_NAME);
    if (!worksheet) return new Map();

    const labels = new Map();

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const audioFileName = row.getCell(1).value;
      const segmentIndex  = parseInt(row.getCell(2).value, 10);
      const speciesLabId  = row.getCell(5).value;
      const chineseName   = row.getCell(6).value || '';
      const englishName   = row.getCell(7).value || '';
      const scientificName = row.getCell(8).value || '';
      const notes         = row.getCell(12).value || '';
      const reviewer      = row.getCell(13).value || '';
      const labelValue    = row.getCell(11).value || 'True';
      const timestampVal  = row.getCell(14).value;

      if (audioFileName && !isNaN(segmentIndex)) {
        const key = `${audioFileName}_${segmentIndex}`;
        if (!labels.has(key)) {
          labels.set(key, []);
        }
        labels.get(key).push({
          speciesLabId: (speciesLabId === '' || speciesLabId === null || speciesLabId === undefined) ? null : String(speciesLabId),
          speciesChineseName: chineseName,
          speciesEnglishName: englishName,
          speciesScientificName: scientificName,
          notes,
          reviewer,
          labelValue,
          timestamp: timestampVal ? new Date(timestampVal) : new Date(),
        });
      }
    });

    return labels;
  }

  _initSheet(ws) {
    // Set headers explicitly by index array to clear memory caches cleanly
    ws.getRow(1).values = COLUMNS.map(c => c.header);
    
    COLUMNS.forEach((col, i) => {
      ws.getColumn(i + 1).width = col.width;
    });

    const headerRow = ws.getRow(1);
    headerRow.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E4057' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height    = 22;
    headerRow.commit();

    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to:   { row: 1, column: COLUMNS.length },
    };
  }
}

module.exports = ExcelJsLabelRepository;