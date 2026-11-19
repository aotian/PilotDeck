#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCourseware } from '../ui/server/courseware-renderer-registry.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const courseRoot = path.join(repo, 'workspaces/cie-cpp-level3');
const lessons = parseLessons(process.argv.find((arg)=>arg.startsWith('--lessons='))?.split('=')[1] || '01-07');
const concurrency = Math.max(1,Math.min(3,Number(process.argv.find((arg)=>arg.startsWith('--concurrency='))?.split('=')[1] || 2)));
const finalizeOnly = process.argv.includes('--finalize-only');
const queue = [...lessons];
const results = [];

await Promise.all(Array.from({length:concurrency}, async () => {
  while (queue.length) {
    const lessonNo = queue.shift();
    const lessonId = `lesson-${lessonNo}`;
    const projectPath = path.join(courseRoot, lessonId);
    try {
      const report = finalizeOnly
        ? JSON.parse(fs.readFileSync(path.join(projectPath,'outputs/tongcheng-teach-html/renderer-report.json'),'utf8'))
        : await renderCourseware({ projectPath, runId:`cie3-${lessonId}-pilot-migration-v1`, renderer:'tongcheng-teach-html', operationMode:'reuse-existing' });
      const teacherHtml = fs.readFileSync(path.join(projectPath,'outputs/tongcheng-teach-html/teacher-deck.html'),'utf8');
      const studentHtml = fs.readFileSync(path.join(projectPath,'outputs/tongcheng-teach-html/student-deck.html'),'utf8');
      finalizeArtifacts(projectPath, report, teacherHtml, studentHtml);
      const item = {
        lessonId, status:'pass', sourceSlides:report.slideCount,
        teacherSlides:count(teacherHtml,/class="slide/g), studentSlides:count(studentHtml,/class="slide/g),
        teacherAnswers:count(teacherHtml,/class="answer-panel/g), studentAnswers:count(studentHtml,/class="answer-panel/g),
        studentTeacherNotes:count(studentHtml,/class="teacher-note/g), editablePptx:report.editable,
        validation:report.validation?.status || 'unknown', durationMs:report.durationMs,
      };
      results.push(item); console.log(JSON.stringify(item));
    } catch (error) {
      const item={lessonId,status:'blocked',error:error.message};results.push(item);console.error(JSON.stringify(item));
    }
  }
}));

results.sort((a,b)=>a.lessonId.localeCompare(b.lessonId));
const summary = {
  schemaVersion:'tongcheng.coursewareBatchRenderReport.v1', renderer:'tongcheng-teach-html',
  status:results.every((item)=>item.status==='pass')?'pass':'blocked', lessons:results,
  totals:{ lessons:results.length, teacherSlides:results.reduce((n,r)=>n+(r.teacherSlides||0),0), studentSlides:results.reduce((n,r)=>n+(r.studentSlides||0),0), durationMs:results.reduce((n,r)=>n+(r.durationMs||0),0) },
  generatedAt:new Date().toISOString(), published:false,
};
fs.writeFileSync(path.join(courseRoot,'batch-render-report.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
process.exit(summary.status==='pass'?0:1);

function parseLessons(value){const m=String(value).match(/^(\d{2})-(\d{2})$/);if(m)return Array.from({length:Number(m[2])-Number(m[1])+1},(_,i)=>String(Number(m[1])+i).padStart(2,'0'));return String(value).split(',').map((x)=>String(Number(x)).padStart(2,'0'));}
function count(text,pattern){return (text.match(pattern)||[]).length;}
function finalizeArtifacts(projectPath,report,teacherHtml,studentHtml){
  const output=path.join(projectPath,'outputs/tongcheng-teach-html');
  fs.writeFileSync(path.join(projectPath,'deck.html'),teacherHtml);
  fs.writeFileSync(path.join(projectPath,'teacher-deck.html'),teacherHtml);
  fs.writeFileSync(path.join(projectPath,'student-deck.html'),studentHtml);
  fs.copyFileSync(path.join(output,'courseware.pptx'),path.join(projectPath,'courseware.pptx'));
  const lessonId=path.basename(projectPath);
  fs.writeFileSync(path.join(projectPath,'generator-handoff.json'),JSON.stringify({schemaVersion:'tongcheng.generatorHandoff.v1',status:'validated-not-published',engine:'pilotdeck',renderer:'tongcheng-teach-html',runId:report.runId,sourceOfTruth:'courseware-slides.json',outputs:{html:'deck.html',teacherHtml:'teacher-deck.html',studentHtml:'student-deck.html',pptx:'courseware.pptx'},publishAllowed:false},null,2)+'\n');
  fs.writeFileSync(path.join(projectPath,'courseware-agent-report.json'),JSON.stringify({schemaVersion:'tongcheng.coursewareAgentReport.v1',lessonId,status:'validated-not-published',renderer:'tongcheng-teach-html',checks:{rendererValidation:report.validation?.status,teacherSlides:count(teacherHtml,/class="slide/g),studentSlides:count(studentHtml,/class="slide/g),studentAnswers:count(studentHtml,/class="answer-panel/g),studentTeacherNotes:count(studentHtml,/class="teacher-note/g),editablePptx:report.editable},publishAllowed:false,generatedAt:new Date().toISOString()},null,2)+'\n');
}
