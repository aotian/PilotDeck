#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repo, 'workspaces/cie-cpp-level3/lesson-08/courseware-slides.json');
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const teacherOnly = new Set([
  'slide-14', 'slide-15', 'slide-16',
  'slide-17', 'slide-18', 'slide-19', 'slide-20', 'slide-21', 'slide-22',
  'slide-23',
]);
const objectiveIds = [
  'e1c4307b-01e0-4135-a3e2-c0c3695ba146','cfaf9c61-f848-49ae-b2fd-cc075ab1b8a9','c5f96001-ef5b-48a4-ab7d-56f63244f9fb','9f9494c5-0af4-4bb8-b432-419214805a0c',
  'e4b7470c-f67c-4cc2-9934-6f6d5d2a7812','95e09422-4846-4513-ab15-04bef36119d1','1d994fa4-085a-4726-9a09-7502762158b0','6b9f20cd-158c-4aa7-a292-f8beba9a6f92',
  '4461d3fd-ef8f-4e94-9494-e9f67b5c780b','491b1a31-8b02-498c-8a49-c99c6168dd9a','638bd635-6a39-4a84-a205-cc457a14fc66','c9c74bb5-8197-43e5-b6a3-6da45a23c239',
];
for (const slide of source.slides) {
  if (teacherOnly.has(slide.id)) slide.audience = 'teacher';
  else delete slide.audience;
  for (const ref of slide.questionRefs || []) {
    const match=String(ref.question_id||'').match(/^l08-q(\d{2})$/);
    if(match)ref.question_id=objectiveIds[Number(match[1])-1];
  }
}
fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2) + '\n');
const refsPath=path.join(repo,'workspaces/cie-cpp-level3/lesson-08/question-refs.json');
if(fs.existsSync(refsPath)){
  const refs=JSON.parse(fs.readFileSync(refsPath,'utf8'));
  refs.objective=objectiveIds;
  fs.writeFileSync(refsPath,JSON.stringify(refs,null,2)+'\n');
}
console.log(JSON.stringify({ ok:true, teacherSlides:source.slides.length, studentSlides:source.slides.filter((slide)=>slide.audience !== 'teacher').length }, null, 2));
