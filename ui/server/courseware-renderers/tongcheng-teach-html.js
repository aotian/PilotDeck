import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { renderAnthropicPptxGenJs } from './anthropic-pptxgenjs.js';
import { makeMontage, runProcess } from '../courseware-renderer-utils.js';

const FORBIDDEN_STUDENT = /教师备注|参考答案|讲解后显示|内部教研|老师讲稿|PilotDeck|OpenMAIC|\bagent\b|prompt/i;

export async function renderTongchengTeachHtml(input, outputDir, options = {}) {
    fs.mkdirSync(outputDir, { recursive: true });
    const teacherPath = path.join(outputDir, 'teacher-deck.html');
    const studentPath = path.join(outputDir, 'student-deck.html');
    fs.writeFileSync(teacherPath, deckHtml(input, 'teacher'));
    fs.writeFileSync(studentPath, deckHtml(input, 'student'));

    const studentHtml = fs.readFileSync(studentPath, 'utf8');
    const blockers = validateHtmlAssets(input, teacherPath, studentPath, studentHtml);
    if (blockers.length) return {
        pptxPath: path.join(outputDir, 'courseware.pptx'),
        validation: { status: 'blocked', blockers, warnings: [], slideCount: input.slideCount, notesCount: 0 },
        editable: false,
        warnings: [],
    };

    const pptx = await renderAnthropicPptxGenJs(input, outputDir);
    const chrome = options.chromeExecutable || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const previews = await renderHtmlPreviews(input, teacherPath, outputDir, chrome);
    return {
        ...pptx,
        teacherHtmlPath: teacherPath,
        studentHtmlPath: studentPath,
        previews,
        editable: true,
        warnings: ['教师/学生 HTML 由同一 courseware-slides.json 派生；PPTX 为原生可编辑对象。'],
    };
}

function validateHtmlAssets(input, teacherPath, studentPath, studentHtml) {
    const blockers = [];
    const teacher = new JSDOM(fs.readFileSync(teacherPath, 'utf8')).window.document;
    const student = new JSDOM(studentHtml).window.document;
    if (teacher.querySelectorAll('.slide').length !== input.slides.length) blockers.push('teacher HTML page count does not match source');
    const expectedStudent = input.slides.filter((slide) => slide.audience !== 'teacher').length;
    if (student.querySelectorAll('.slide').length !== expectedStudent) blockers.push('student HTML page count does not match audience-filtered source');
    if (student.querySelector('.teacher-note,.answer-panel,.answer-toggle')) blockers.push('student HTML contains teacher-only notes or answers');
    if (FORBIDDEN_STUDENT.test(student.body.textContent || '')) blockers.push('student HTML contains protected teacher wording');
    for (const link of student.querySelectorAll('a.oj-link')) {
        const href = link.getAttribute('href') || '';
        if (!href.startsWith('https://learn.tongchengweilai.com/oj-do.html?')) blockers.push('student OJ link does not route through Learn');
        if (link.getAttribute('target') !== '_top') blockers.push('student OJ link must escape iframe with target=_top');
    }
    return blockers;
}

function deckHtml(input, role) {
    const slides = input.slides.filter((slide) => role === 'teacher' || slide.audience !== 'teacher');
    const pages = slides.map((slide, index) => slideHtml(slide, index, slides.length, role)).join('\n');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(input.lessonId || '童澄课堂')}</title><style>${css()}body[data-role="teacher"]{--teach-toolbar-safe:15%}body[data-role="teacher"] .slide main{height:calc(100% - var(--teach-toolbar-safe))}body[data-role="teacher"] .teacher-note{bottom:0}body[data-role="teacher"] nav{bottom:calc(var(--teach-toolbar-safe) + 1%)}body[data-role="teacher"] .slide[data-id="slide-01"] h1{margin-top:7%}body[data-role="teacher"] .slide[data-id="slide-01"] .flow{margin-top:1.5%}
</style></head><body data-role="${role}"><div class="deck">${pages}</div><nav><button data-dir="-1" aria-label="上一页">←</button><span id="counter">1 / ${slides.length}</span><button data-dir="1" aria-label="下一页">→</button>${role === 'teacher' ? '<button id="timer">⏱ 15:00</button>' : ''}<button id="full">全屏</button></nav><script>${script()}</script></body></html>`;
}

function slideHtml(slide, index, count, role) {
    const answer = role === 'teacher' && slide.answer
        ? `<button class="answer-toggle" aria-expanded="false">点击显示答案</button><div class="answer-panel" hidden>${slide.answer}</div>` : '';
    const note = role === 'teacher' && slide.notes ? `<aside class="teacher-note"><b>教师提示</b>${esc(slide.notes)}</aside>` : '';
    const oj = slide.oj ? `<div class="oj-card"><span class="level">${esc(slide.oj.level || '课堂练习')}</span><h3>${esc(slide.oj.title)}</h3><p>完整题面、样例和在线评测请在 Learn 中打开。</p><a class="oj-link" href="${attr(slide.oj.learnUrl)}" target="_top">进入 Learn 练习 →</a></div>` : '';
    return `<section class="slide${index === 0 ? ' active' : ''}" data-index="${index}" data-id="${attr(slide.id)}"><header><span>中国电子学会 C/C++ 三级 · 08</span><span>${index + 1} / ${count}</span></header><main>${slide.html || ''}${oj}${answer}${note}</main><footer><span>童澄未来 · 真题考点驱动 · 练习闭环</span><span>← → 翻页</span></footer></section>`;
}

function css() { return `
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;color:#172033;background:#172033}.deck{width:100%;height:100%;display:grid;place-items:center}.slide{display:none;position:relative;width:min(100vw,177.777vh);height:min(56.25vw,100vh);background:#fffaf5;overflow:hidden;padding:4.4% 5.2% 4.5%}.slide.active{display:block}.slide:before{content:"";position:absolute;right:-7%;top:-18%;width:34%;height:54%;border-radius:50%;background:#ffedd5}.slide header,.slide footer{position:absolute;left:5.2%;right:5.2%;display:flex;justify-content:space-between;color:#9a3412;font-weight:700;z-index:2}.slide header{top:3.2%;font-size:clamp(12px,1.25vw,21px);border-bottom:2px solid #fed7aa;padding-bottom:1%}.slide footer{bottom:2.2%;font-size:clamp(9px,.82vw,14px);font-weight:500;color:#9a6b54}.slide main{position:relative;z-index:1;height:100%;padding-top:3.8%}.slide h1{font-size:clamp(34px,4vw,68px);line-height:1.1;margin:10% 0 2.2%;color:#d94e00;max-width:78%}.slide h2{font-size:clamp(28px,3.1vw,52px);line-height:1.18;margin:2.5% 0 3%;color:#d94e00}.slide h3{font-size:clamp(18px,1.8vw,30px);margin:.6em 0;color:#172033}.slide p,.slide li{font-size:clamp(15px,1.55vw,27px);line-height:1.52}.slide ul,.slide ol{padding-left:1.5em}.slide li{margin:.38em 0}.slide code{font-family:"Courier New",monospace;background:#fff1e6;padding:.08em .25em;border-radius:.25em;color:#9a3412}.slide pre{font-family:"Courier New",monospace;font-size:clamp(13px,1.35vw,23px);line-height:1.45;background:#172033;color:#fff;padding:1.2em;border-radius:18px;overflow:hidden;white-space:pre-wrap}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2.2%}.card,.oj-card,.answer-panel,.teacher-note{background:#fff;border:2px solid #fed7aa;border-radius:20px;padding:1.4em;box-shadow:0 12px 32px #9a341216}.card strong{color:#d94e00}.flow{display:flex;align-items:center;gap:1.2%;margin:3% 0}.flow span{flex:1;background:#fff;border:2px solid #fb923c;border-radius:18px;padding:1.2em;text-align:center;font-size:clamp(15px,1.55vw,27px);font-weight:700}.flow b{color:#f97316;font-size:2vw}.demo{display:grid;grid-template-columns:1fr 1fr;gap:3%}.demo-controls{background:#172033;color:#fff;border-radius:20px;padding:1.5em}.candidate{display:inline-grid;place-items:center;width:2.3em;height:2.3em;margin:.25em;border-radius:50%;background:#fff1e6;border:2px solid #fb923c;font-size:1.4vw}.candidate.hit{background:#0f9f79;color:#fff;border-color:#0f9f79}.answer-toggle,nav button,.oj-link,.demo button{border:0;border-radius:999px;background:#f97316;color:white;font-weight:700;padding:.7em 1.15em;font-size:clamp(12px,1vw,18px);cursor:pointer;text-decoration:none;display:inline-block}.answer-toggle{margin-top:1em}.answer-panel{margin-top:.7em;border-color:#0f9f79;background:#ecfdf5;font-size:clamp(14px,1.35vw,23px)}.teacher-note{position:absolute;right:0;bottom:4%;width:32%;font-size:clamp(10px,.9vw,16px);background:#fff7ed}.teacher-note b{display:block;color:#c2410c}.oj-card{max-width:74%;margin:4% auto}.oj-card .level{color:#c2410c;font-weight:700}.oj-card p{font-size:clamp(13px,1.2vw,21px)}nav{position:fixed;z-index:10;left:50%;bottom:2%;transform:translateX(-50%);display:flex;align-items:center;gap:.6em;background:#172033eF;border-radius:999px;padding:.5em .8em;color:white;box-shadow:0 8px 26px #0007}nav button{padding:.55em .85em}#counter{min-width:6em;text-align:center;font-weight:700}@media print{html,body{overflow:visible;background:white}.deck{display:block}.slide{display:block;width:13.333in;height:7.5in;break-after:page}nav{display:none}}
`; }

function script() { return `
const slides=[...document.querySelectorAll('.slide')];let current=0;function show(n){current=(n+slides.length)%slides.length;slides.forEach((s,i)=>s.classList.toggle('active',i===current));document.getElementById('counter').textContent=(current+1)+' / '+slides.length}show(Math.max(0,Number(new URLSearchParams(location.search).get('slide')||1)-1));document.querySelectorAll('[data-dir]').forEach(b=>b.onclick=()=>show(current+Number(b.dataset.dir)));document.addEventListener('keydown',e=>{if(['ArrowRight','PageDown',' '].includes(e.key))show(current+1);if(['ArrowLeft','PageUp'].includes(e.key))show(current-1);if(e.key.toLowerCase()==='f')document.documentElement.requestFullscreen?.()});document.querySelectorAll('.answer-toggle').forEach(b=>b.onclick=()=>{const p=b.nextElementSibling;const open=p.hidden;p.hidden=!open;b.setAttribute('aria-expanded',String(open));b.textContent=open?'收起答案':'点击显示答案'});document.getElementById('full').onclick=()=>document.documentElement.requestFullscreen?.();let remain=900,clock;const timer=document.getElementById('timer');if(timer)timer.onclick=()=>{if(clock){clearInterval(clock);clock=null;return}clock=setInterval(()=>{remain=Math.max(0,remain-1);timer.textContent='⏱ '+String(Math.floor(remain/60)).padStart(2,'0')+':'+String(remain%60).padStart(2,'0');if(!remain){clearInterval(clock);clock=null}},1000)};document.querySelectorAll('[data-enum]').forEach(btn=>btn.onclick=()=>{const box=document.querySelector(btn.dataset.enum);if(!box)return;box.querySelectorAll('.candidate').forEach((node,i)=>node.classList.toggle('hit',(i+1)%Number(btn.dataset.mod||2)===0))});
`; }

async function renderHtmlPreviews(input, teacherPath, outputDir, chrome) {
    if (!fs.existsSync(chrome)) return { pngs: [], montage: null };
    const dir = path.join(outputDir, 'html-previews'); fs.mkdirSync(dir, { recursive: true });
    const pngs = [];
    for (let index = 0; index < input.slides.length; index += 1) {
        const target = path.join(dir, `slide-${String(index + 1).padStart(2, '0')}.png`);
        const url = `${pathToFileURL(teacherPath).href}?slide=${index + 1}`;
        await runProcess(chrome, ['--headless=new','--disable-gpu','--no-sandbox','--hide-scrollbars','--window-size=1280,720',`--screenshot=${target}`,url]);
        pngs.push(target);
    }
    const montage = path.join(dir, 'montage.png'); await makeMontage(pngs, montage);
    return { pngs, montage };
}

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function attr(value) { return esc(value).replace(/`/g, '&#96;'); }
