// Compares a second reviewer's grades with the judge's on a spot-check sheet.
//   node scorer/spot-check-compare.ts <sheet.csv> <review.json>
// review.json: { reviewer, grades: { "<question>": "row:TF row:TT ..." } }, one letter per required element.
import { readFileSync } from 'node:fs';
import { parseCsv } from './spot-check-view.ts';

const [sheet, reviewFile] = process.argv.slice(2);
const rows = parseCsv(readFileSync(sheet!, 'utf8')).slice(1);
const review = JSON.parse(readFileSync(reviewFile!, 'utf8')) as { reviewer: string; grades: Record<string, string> };

console.log(`Reviewer: ${review.reviewer}\n`);
const disagreements: string[] = [];
let allSame = 0, all = 0;
for (const [question, text] of Object.entries(review.grades)) {
  const mine = new Map(text.trim().split(/\s+/).map((x) => x.split(':') as [string, string]));
  const sheetRows = rows.map((r, i) => ({ r, n: i + 1 })).filter((x) => x.r[1] === question);
  if (sheetRows.length !== mine.size) throw new Error(`${question}: sheet has ${sheetRows.length} rows, review has ${mine.size}`);
  let passSame = 0, judgePass = 0, minePass = 0;
  const elementSame: number[] = [], elements: string[] = [];
  for (const { r, n } of sheetRows) {
    const judge = r[4]!.split(' / ').map((e) => e.startsWith('MET'));
    r[4]!.split(' / ').forEach((e, i) => (elements[i] = e.replace(/^(NOT )?MET: /, '')));
    const m = [...mine.get(String(n))!].map((c) => c === 'T');
    if (m.length !== judge.length) throw new Error(`row ${n}: element count differs`);
    judge.forEach((j, i) => (elementSame[i] = (elementSame[i] ?? 0) + (j === m[i] ? 1 : 0)));
    const jp = judge.every(Boolean), mp = m.every(Boolean);
    judgePass += +jp; minePass += +mp; passSame += +(jp === mp);
    if (jp !== mp) disagreements.push(`row ${n} ${question}: judge ${jp ? 'pass' : 'fail'}, reviewer ${mp ? 'pass' : 'fail'} | ${r[6]} | ${r[3]!.slice(0, 160)}`);
  }
  const n = sheetRows.length;
  all += n; allSame += passSame;
  console.log(`${question}: ${n} answers, same pass/fail on ${passSame} (${Math.round((100 * passSame) / n)}%). Judge passed ${judgePass}, reviewer passed ${minePass}.`);
  elements.forEach((e, i) => console.log(`   element "${e}": agree on ${elementSame[i]}/${n}`));
}
console.log(`\nOverall: same pass/fail on ${allSame} of ${all} (${Math.round((100 * allSame) / all)}%)\n\nDisagreements:`);
for (const d of disagreements) console.log(`- ${d}`);
