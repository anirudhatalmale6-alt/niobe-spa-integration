// Shared CSV writing. One implementation of the formula-injection guard, because getting it
// right in one exporter and forgetting it in the next is how it ends up shipping.

// A cell beginning = + - @ is executed as a formula by Excel/Sheets when the file is opened.
// Product names, customer names and service names all come from data people type into
// SimpleSpa, so a name entered as "-Elemis sample" would run as one. Prefix those with an
// apostrophe: Excel shows the text and never evaluates it. Plain numbers we generate
// ourselves are exempt, otherwise every negative figure would gain a stray quote.
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const csvRow = (cells) => cells.map(csvCell).join(',');

// BOM so Excel reads it as UTF-8, CRLF because that is what Excel writes.
export const csvFile = (lines) => `﻿${lines.join('\r\n')}\r\n`;

// Reading the sheets Niobe edits in Excel and hands back (staff list, monthly pay
// adjustments): quoted fields, doubled quotes, commas and newlines inside quotes, CRLF and
// the byte-order mark Excel adds. Blank rows are dropped.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}
