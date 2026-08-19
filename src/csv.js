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
