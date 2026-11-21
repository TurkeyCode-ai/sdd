// Prints a spot-check sheet without the judge's grades, for blind regrading.
//   node scorer/spot-check-view.ts <sheet.csv> <question id>
import { readFileSync } from 'node:fs';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

if (import.meta.main) {
  const [file, question] = process.argv.slice(2);
  const rows = parseCsv(readFileSync(file!, 'utf8')).slice(1);
  rows.forEach((r, i) => { if (r[1] === question) console.log(`${i + 1}. ${r[3]}`); });
}
