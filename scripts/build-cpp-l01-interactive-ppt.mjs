#!/usr/bin/env node
import pptxgen from 'pptxgenjs'
import fs from 'node:fs'
import path from 'node:path'

const outDir='/Users/tongcheng/Projects/PilotDeck/workspaces/cpp-olympiad-basics/lesson-01-v2/outputs/codex-interactive'
fs.mkdirSync(outDir,{recursive:true})
const out=path.join(outDir,'courseware-interactive.pptx')
const pptx=new pptxgen(); pptx.layout='LAYOUT_WIDE'; pptx.author='Tongcheng · PilotDeck CodexPPT'; pptx.subject='C++语法基础课教师交互课件'; pptx.title='第1课 让第一段C++程序运行起来'; pptx.company='童程未来'; pptx.lang='zh-CN'; pptx.theme={headFontFace:'Hiragino Sans GB',bodyFontFace:'Hiragino Sans GB',lang:'zh-CN'}
const C={ink:'172033',paper:'F8FAFC',white:'FFFFFF',orange:'F97316',green:'0F9F79',red:'DC2626',blue:'2563EB',muted:'64748B',line:'CBD5E1',code:'111827'}
const W=13.333,H=7.5
function base(title,kicker='C++ 语法基础 · 01'){
 const s=pptx.addSlide();s.background={color:C.paper}
 s.addText(kicker,{x:.55,y:.28,w:4,h:.3,fontFace:'Hiragino Sans GB',fontSize:11,bold:true,color:C.orange,margin:0})
 s.addText(title,{x:.55,y:.72,w:12.2,h:.62,fontFace:'Hiragino Sans GB',fontSize:27,bold:true,color:C.ink,margin:0,breakLine:false,fit:'shrink'})
 s.addText(String(pptx._slides.length).padStart(2,'0'),{x:12.25,y:.3,w:.5,h:.25,fontFace:'Hiragino Sans GB',fontSize:10,color:C.muted,align:'right',margin:0})
 return s
}
function btn(s,text,x,y,w,h,link,color=C.orange){s.addText(text,{x,y,w,h,fontFace:'Hiragino Sans GB',fontSize:15,bold:true,color:C.white,align:'center',valign:'mid',margin:.08,fill:{color},line:{color},radius:.12,hyperlink:link})}
function card(s,title,body,x,y,w,h,color=C.white){s.addShape(pptx.ShapeType.roundRect,{x,y,w,h,rectRadius:.08,fill:{color},line:{color:C.line,width:1}});s.addText(title,{x:x+.22,y:y+.18,w:w-.44,h:.32,fontFace:'Hiragino Sans GB',fontSize:17,bold:true,color:C.ink,margin:0});s.addText(body,{x:x+.22,y:y+.62,w:w-.44,h:h-.82,fontFace:'Hiragino Sans GB',fontSize:13,color:C.muted,margin:0,breakLine:false,fit:'shrink'})}
function code(s,txt,x,y,w,h){s.addText(txt,{x,y,w,h,fontFace:'Courier New',fontSize:17,color:C.white,margin:.25,fill:{color:C.code},line:{color:C.code},breakLine:false,fit:'shrink'})}
function notes(s,t){s.addNotes(t)}

{
 const s=pptx.addSlide();s.background={color:C.code};s.addText('让第一段 C++ 程序\n真正运行起来',{x:.7,y:1.25,w:8.8,h:1.6,fontFace:'Hiragino Sans GB',fontSize:34,bold:true,color:C.white,margin:0,breakLine:false});s.addText('结构识别 × 编译运行 × 错误定位 × 第一次 AC',{x:.72,y:3.25,w:8,h:.5,fontFace:'Hiragino Sans GB',fontSize:18,color:'CBD5E1',margin:0});btn(s,'进入课堂导航',.72,5.35,2.5,.62,{slide:2});card(s,'课堂证据','完成结构指认、代码拼装、错误诊断与 OJ 投放。',9.35,1.25,3.2,3.2,'1E293B');notes(s,'封面页。点击“进入课堂导航”，不要按线性方式讲完整套课件。')
}
{
 const s=base('课堂导航｜3道例题 · 3道对应习题');card(s,'例题1 / 习题1','程序拼装 → 输出变式',.6,1.7,2.85,2.1);card(s,'例题2 / 习题2','错误定位 → 独立修错',3.65,1.7,2.85,2.1);card(s,'例题3 / 习题3','错误分类 → 程序判错',6.7,1.7,2.85,2.1);card(s,'巩固与OJ','12道分层题＋三阶OJ',9.75,1.7,2.85,2.1);btn(s,'进入例题1',.9,4.5,2.2,.65,{slide:9},C.blue);btn(s,'进入例题2',3.95,4.5,2.2,.65,{slide:11},C.orange);btn(s,'进入例题3',7,4.5,2.2,.65,{slide:15},C.red);btn(s,'进入3道习题',10.05,4.5,2.2,.65,{slide:14},C.green);notes(s,'每道例题后立即投放对应习题；分层题组和OJ不能替代3例3练。')
}
{
 const s=base('一段完整程序，是一张“执行地图”');code(s,'#include <iostream>\nusing namespace std;\n\nint main() {\n  cout << "Hello";\n  return 0;\n}',.7,1.6,6.3,4.75);card(s,'① 准备工具','#include <iostream>',7.35,1.6,2.35,1.35);card(s,'② 确定入口','int main()',9.95,1.6,2.35,1.35);card(s,'③ 执行任务','cout 输出语句',7.35,3.25,2.35,1.35);card(s,'④ 划定范围','{ } 与 return',9.95,3.25,2.35,1.35);btn(s,'课堂点击实验',8.15,5.35,3.4,.62,{slide:4});notes(s,'先让学生口述四个区域，再进入点击实验页。')
}
{
 const s=base('点击实验｜这行代码负责什么？');code(s,'cout << "Hello";',1.0,2.0,6.2,1.35);btn(s,'A 程序入口',8.0,1.7,3.4,.62,{slide:5},C.blue);btn(s,'B 向屏幕输出',8.0,2.65,3.4,.62,{slide:5},C.green);btn(s,'C 添加注释',8.0,3.6,3.4,.62,{slide:5},C.red);btn(s,'返回导航',.7,6.3,1.8,.5,{slide:2},C.muted);notes(s,'让学生先举牌，再点击选项。下一页用于揭示并追问各符号作用。')
}
{
 const s=base('验证｜cout 负责输出，但要读完整条语句');card(s,'cout','输出对象',.8,1.8,2.5,2.0);card(s,'<<','把右侧内容送向输出对象',3.55,1.8,2.5,2.0);card(s,'"Hello"','字符串文字',6.3,1.8,2.5,2.0);card(s,';','一条语句结束',9.05,1.8,2.5,2.0);btn(s,'返回题目',3.7,5.15,2.2,.58,{slide:4},C.blue);btn(s,'进入诊断',7.0,5.15,2.2,.58,{slide:6});notes(s,'验证页不是直接报答案；要求学生解释四个组成部分。')
}
{
 const s=base('诊断题｜删除 cout 后的分号，最可能发生什么？');code(s,'cout << "Hello"\nreturn 0;',.9,1.75,5.4,2.4);btn(s,'A 编译错误',7.0,1.7,2.25,.65,{slide:7},C.blue);btn(s,'B 输出不变',9.65,1.7,2.25,.65,{slide:8},C.red);btn(s,'C 无限循环',7.0,2.75,2.25,.65,{slide:8},C.red);btn(s,'D 只少一个字符',9.65,2.75,2.25,.65,{slide:8},C.red);btn(s,'返回导航',.7,6.3,1.8,.5,{slide:2},C.muted);notes(s,'先投票再点击。选错进入提示页，选对进入证据页。')
}
{
 const s=base('判断正确｜这是编译阶段的语法错误','反馈分支 · 正确');card(s,'证据','编译器无法确认第一条语句在哪里结束。',1.0,1.8,5.1,2.4,'DCFCE7');card(s,'最小修改','只补上缺失的分号，然后重新编译、运行。',7.0,1.8,5.1,2.4,'DBEAFE');btn(s,'继续错误诊所',4.9,5.3,3.2,.62,{slide:11},C.green);notes(s,'正确页强调证据与最小修改，不只给选项字母。')
}
{
 const s=base('暂未通过｜先区分“能不能运行”和“结果对不对”','反馈分支 · 提示');card(s,'第一问','这段代码能通过编译吗？',1.0,1.8,4.9,2.2,'FEE2E2');card(s,'第二问','如果不能运行，是否已经有“输出结果”？',7.0,1.8,4.9,2.2,'FFF7ED');btn(s,'带着提示重答',4.9,5.2,3.2,.62,{slide:6},C.orange);notes(s,'错误页不给最终答案，提供两层提示并跳回原题。')
}
{
 const s=base('例题1｜把代码块拼成可靠顺序');card(s,'1','#include <iostream>',.7,1.7,2.2,1.3);card(s,'2','int main() {',3.05,1.7,2.2,1.3);card(s,'3','cout << "Hello";',5.4,1.7,2.2,1.3);card(s,'4','return 0;',7.75,1.7,2.2,1.3);card(s,'5','}',10.1,1.7,2.2,1.3);s.addText('先预测顺序，再逐块说明职责，最后进入学生端实际拼装。',{x:1.15,y:4.0,w:8.6,h:.55,fontFace:'Hiragino Sans GB',fontSize:20,bold:true,color:C.ink,margin:0});btn(s,'验证并做变式',9.9,4.0,2.2,.62,{slide:10});notes(s,'例题过程：读块—预测—排序—解释—替换输出内容做变式。')
}
{
 const s=base('验证｜顺序正确只是第一层');card(s,'结构','头文件 → main → 语句 → return → }',.9,1.7,5.5,2.0,'DCFCE7');card(s,'解释','能说清“为什么这样排”，才算真正完成。',6.9,1.7,5.5,2.0,'DBEAFE');btn(s,'再做错误定位',4.9,5.0,3.2,.62,{slide:11},C.red);notes(s,'要求学生逐块解释职责。')
}
{
 const s=base('例题2｜错误诊所：第一处应该修改哪里？');code(s,'1  #include <iostream>\n2  using namespace std;\n3  int main() {\n4    cout << "Hello"\n5    return 0;\n6  }',.7,1.55,6.2,4.7);btn(s,'第 3 行',7.55,1.8,2.0,.65,{slide:13},C.red);btn(s,'第 4 行',9.95,1.8,2.0,.65,{slide:12},C.green);btn(s,'第 5 行',7.55,2.9,2.0,.65,{slide:13},C.red);btn(s,'我需要提示',9.95,2.9,2.0,.65,{slide:13},C.orange);btn(s,'返回导航',.7,6.35,1.8,.48,{slide:2},C.muted);notes(s,'例题过程：描述现象—定位第一处—最小修改—重新编译—回归测试。')
}
{
 const s=base('定位正确｜第4行缺少分号','反馈分支 · 正确');card(s,'现象','无法通过编译',.8,1.7,2.7,2.0);card(s,'位置','第4行语句末尾',3.75,1.7,2.7,2.0);card(s,'修改','补一个分号',6.7,1.7,2.7,2.0);card(s,'复测','重新编译并运行',9.65,1.7,2.7,2.0);btn(s,'进入练习',5.05,5.0,3.0,.62,{slide:14},C.green);notes(s,'让学生完整复述四步调试链。')
}
{
 const s=base('提示｜寻找“完整语句”的结束位置','反馈分支 · 提示');code(s,'cout << "Hello"  ← 这条语句在哪里结束？',1.1,2.0,8.4,1.3);btn(s,'返回原题再定位',9.8,2.3,2.2,.62,{slide:11},C.orange);notes(s,'提示聚焦语句结束符，不直接标出答案。')
}
{
 const s=base('3道对应习题｜完成后再进入巩固题组');card(s,'习题1 · 输出变式','替换输出内容，独立预测并运行',.7,1.7,3.7,2.3);card(s,'习题2 · 独立修错','换一种结构错误，完成最小修改和复测',4.8,1.7,3.7,2.3);card(s,'习题3 · 程序判错','判断能否编译、能否运行、答案是否正确',8.9,1.7,3.7,2.3);btn(s,'进入例题3/习题3',4.9,4.75,3.5,.62,{slide:15},C.blue);btn(s,'完成后进入OJ',9.4,4.75,2.5,.62,{slide:17},C.green);btn(s,'返回导航',.7,6.3,1.8,.5,{slide:2},C.muted);notes(s,'3道习题是一一对应的无提示迁移任务；之后仍需完成基础、标准、提高各4题。')
}
{
 const s=base('例题3｜程序能运行，但少输出一个感叹号，属于？');btn(s,'A 编译错误',1.0,2.0,2.5,.75,{slide:16},C.red);btn(s,'B 运行错误',3.9,2.0,2.5,.75,{slide:16},C.red);btn(s,'C 答案错误',6.8,2.0,2.5,.75,{slide:16},C.green);btn(s,'D 头文件错误',9.7,2.0,2.5,.75,{slide:16},C.red);s.addText('先判断能否编译、能否运行，再核对输出是否符合要求。',{x:1.2,y:4.1,w:10.8,h:.65,fontFace:'Hiragino Sans GB',fontSize:20,bold:true,color:C.ink,align:'center',margin:0});notes(s,'例题3示范三层判断；讲评后投放习题3，换一段能运行但输出错误的程序。')
}
{
 const s=base('讲评｜能运行 ≠ 答案正确');card(s,'编译错误','语法不完整，程序通常不能运行。',.8,1.7,3.7,2.3,'FEE2E2');card(s,'答案错误','程序运行完成，但结果不符合题目要求。',4.8,1.7,3.7,2.3,'DCFCE7');card(s,'回归测试','修改后必须重新编译、运行、核对。',8.8,1.7,3.7,2.3,'DBEAFE');btn(s,'进入 OJ',5.1,5.0,3.1,.62,{slide:17},C.green);notes(s,'正确答案是 C。要求学生用反例区分编译错误与答案错误。')
}
{
 const s=base('OJ 三阶投放｜从课堂进入 Learn');card(s,'T1001 · 基础','Hello,World!｜本课必须 AC',.7,1.65,3.7,2.7);card(s,'T1004 · 标准','字符三角形｜正式提交',4.8,1.65,3.7,2.7);card(s,'T1000 · 挑战','A+B问题｜选做',8.9,1.65,3.7,2.7);btn(s,'打开 T1001',1.35,3.72,2.35,.55,{url:'https://learn.tongchengweilai.com/oj-do.html?oj_problem_id=T1001'},C.green);btn(s,'打开 T1004',5.45,3.72,2.35,.55,{url:'https://learn.tongchengweilai.com/oj-do.html?oj_problem_id=T1004'},C.green);btn(s,'打开 T1000',9.55,3.72,2.35,.55,{url:'https://learn.tongchengweilai.com/oj-do.html?oj_problem_id=T1000'},C.green);btn(s,'课堂收束',5.15,5.6,3.0,.6,{slide:18});notes(s,'三个链接均通过 Learn。正式完成状态必须读取 OJ AC 回执。')
}
{
 const s=base('收束｜今天留下四类学习证据');card(s,'看懂','指出程序四个关键区域',.8,1.6,2.7,2.1);card(s,'拼对','组成一段完整程序',3.75,1.6,2.7,2.1);card(s,'修好','最小修改并完成复测',6.7,1.6,2.7,2.1);card(s,'跑通','OJ 至少完成 T1001',9.65,1.6,2.7,2.1);btn(s,'返回课堂导航',5.0,5.1,3.3,.62,{slide:2},C.orange);notes(s,'教师查看真实作答与 OJ 证据，不展示未学习数据。')
}

await pptx.writeFile({fileName:out})
console.log(JSON.stringify({ok:true,file:out,slides:pptx._slides.length,nativeLinks:true},null,2))
