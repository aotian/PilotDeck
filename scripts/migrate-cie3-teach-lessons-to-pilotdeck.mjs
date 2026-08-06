#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const teachRoot = process.env.TEACH_PLATFORM_ROOT || '/Users/tongcheng/Projects/TEACH-platform';
const courseSource = path.join(teachRoot, 'courseware/cie-cpp-level3');
const courseTarget = path.join(repo, 'workspaces/cie-cpp-level3');
const lessonNumbers = parseLessons(process.argv.find((arg) => arg.startsWith('--lessons='))?.split('=')[1] || '01-07');
const reports = [];

for (const lessonNo of lessonNumbers) {
  const lessonKey = `lesson-${lessonNo}`;
  const sourceRoot = path.join(courseSource, lessonKey);
  const targetRoot = path.join(courseTarget, lessonKey);
  const legacy = readJson(path.join(sourceRoot, 'courseware-slides.json'));
  const seedPath = path.join(sourceRoot, 'tiku-seed.json');
  const packagePath = path.join(sourceRoot, 'self-study-package.json');
  const seed = fs.existsSync(seedPath) ? readJson(seedPath) : null;
  const packageRefs = fs.existsSync(packagePath) ? (readJson(packagePath).question_refs || []) : [];
  const packagedObjectiveRefs = packageRefs.filter((ref) => ref.kind === 'objective').map(normalizeRef);
  const packagedOjRefs = packageRefs.filter((ref) => ref.kind === 'oj').map(normalizeRef);
  const objectiveRefs = packagedObjectiveRefs.length
    ? packagedObjectiveRefs
    : (seed?.objective_questions || []).map((question) => ({ question_id:question.id, kind:'objective', source_table:'quiz_questions' }));
  const ojRefs = packagedOjRefs.length
    ? packagedOjRefs
    : (seed?.oj_questions || []).map((question) => ({ question_id:question.id, kind:'oj', source_table:'quiz_questions', oj_problem_id:question.oj_problem_id }));
  let questionOffset = 0;
  let programOffset = 0;
  const slides = legacy.slides.map((slide, index) => {
    const teacherOnly = ['questions','answers','program'].includes(slide.type);
    const heading = slide.type === 'cover' || slide.type === 'close' ? 'h1' : 'h2';
    const item = {
      id:String(slide.id || `slide-${String(index + 1).padStart(2,'0')}`),
      order:index + 1,
      type:String(slide.type || 'content'),
      title:String(slide.title || `第 ${index + 1} 页`),
      html:`<section><${heading}>${escapeHtml(slide.title || '')}</${heading}>${slide.body || ''}</section>`,
      notes:String(slide.notes || ''),
    };
    if (teacherOnly) item.audience = 'teacher';
    if (slide.type === 'questions') {
      item.questionRefs = objectiveRefs.slice(questionOffset, questionOffset + 4);
      questionOffset += 4;
    }
    if (slide.type === 'answers') {
      item.html = `<section><h2>${escapeHtml(slide.title || '随堂练习解析')}</h2><p>请先让学生说明理由，再点击显示解析。</p></section>`;
      item.answer = String(slide.body || '').replace(/<button class="reveal"[\s\S]*?<\/button>/g, '');
    }
    if (slide.type === 'program') {
      const ref = ojRefs[programOffset++];
      if (ref) item.questionRefs = [ref];
    }
    return item;
  });
  const source = {
    schemaVersion:'tiku.coursewareSlides.v1',
    coursePackageId:'cie-cpp-level3',
    lessonDbId:null,
    lessonId:lessonKey,
    title:String(legacy.title || slides[0]?.title || lessonKey),
    studentVisibility:'student',
    migration:{ source:'TEACH-platform', sourceOfTruth:'courseware-slides.json', renderer:'tongcheng-teach-html', migratedAt:new Date().toISOString() },
    slides,
  };
  fs.mkdirSync(targetRoot, { recursive:true });
  writeJson(path.join(targetRoot, 'courseware-slides.json'), source);
  writeJson(path.join(targetRoot, 'question-refs.json'), [...objectiveRefs, ...ojRefs]);
  copyIfExists(path.join(sourceRoot, 'approved-style.json'), path.join(targetRoot, 'approved-style.json'));
  for (const file of ['brief.md','course-outline.md','teacher-script.md','student-topic-content.md','exercises.md','solutions.md','oj-exercises.md','homework.md','pitfalls.md','self-study-package.json','courseware-package.json','slides-manifest.json','compile-test-results.json']) {
    copyIfExists(path.join(sourceRoot,file), path.join(targetRoot,file));
  }
  const studentSlides = slides.filter((slide) => slide.audience !== 'teacher').length;
  const report = {
    schemaVersion:'tongcheng.coursewareMigrationReport.v1', lessonId:lessonKey,
    sourcePath:path.join(sourceRoot,'courseware-slides.json'), targetPath:path.join(targetRoot,'courseware-slides.json'),
    sourceSlides:legacy.slides.length, teacherSlides:slides.length, studentSlides,
    objectiveQuestions:objectiveRefs.length, programmingQuestions:ojRefs.length,
    teacherOnlySlides:slides.length - studentSlides, renderer:'tongcheng-teach-html',
    sourceHashFile:'courseware-slides.json', published:false,
  };
  writeJson(path.join(targetRoot,'migration-report.json'),report);
  reports.push(report);
}

writeJson(path.join(courseTarget,'migration-summary.json'),{
  schemaVersion:'tongcheng.coursewareMigrationSummary.v1', courseId:'cie-cpp-level3',
  status:'migrated-pending-render-validation', lessons:reports,
  totals:{ lessons:reports.length, teacherSlides:reports.reduce((n,r)=>n+r.teacherSlides,0), studentSlides:reports.reduce((n,r)=>n+r.studentSlides,0), objectiveQuestions:reports.reduce((n,r)=>n+r.objectiveQuestions,0), programmingQuestions:reports.reduce((n,r)=>n+r.programmingQuestions,0) },
  generatedAt:new Date().toISOString(), published:false,
});
console.log(JSON.stringify({ok:true,lessons:reports.map((r)=>r.lessonId),totals:readJson(path.join(courseTarget,'migration-summary.json')).totals},null,2));

function parseLessons(value) {
  const match = String(value).match(/^(\d{2})-(\d{2})$/);
  if (match) return Array.from({length:Number(match[2])-Number(match[1])+1},(_,i)=>String(Number(match[1])+i).padStart(2,'0'));
  return String(value).split(',').map((item)=>String(Number(item)).padStart(2,'0'));
}
function readJson(file) { return JSON.parse(fs.readFileSync(file,'utf8')); }
function writeJson(file,value) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n'); }
function copyIfExists(from,to) { if(fs.existsSync(from)){fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);} }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g,(c)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function normalizeRef(ref) { return { question_id:ref.question_id, kind:ref.kind, source_table:'quiz_questions', ...(ref.oj_problem_id ? { oj_problem_id:ref.oj_problem_id } : {}) }; }
