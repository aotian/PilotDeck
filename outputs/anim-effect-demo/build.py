#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
动画效果测试 pptx
- 4 页 16:9 白底
- 每页一个色块 + 短标题（"淡入" / "淡出" / "放大缩小" / "擦除"）
- 真实 PowerPoint 动画（p:timing，含 clickEffect）和切换（p:transition）
- 品牌：童澄
"""
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.oxml.ns import qn
from lxml import etree
import copy

# ---------- 1. 基础设置 ----------
OUT = "/Users/tongcheng/Projects/PilotDeck/outputs/anim-effect-demo/动画效果测试.pptx"

prs = Presentation()
# 16:9 = 13.333" x 7.5"
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

SLIDE_W = prs.slide_width
SLIDE_H = prs.slide_height

BLANK = prs.slide_layouts[6]  # 空白版式

# 颜色
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
BLACK = RGBColor(0x10, 0x10, 0x10)
GREY = RGBColor(0x66, 0x66, 0x66)
BLUE = RGBColor(0x1F, 0x6F, 0xEB)
ORANGE = RGBColor(0xF5, 0x82, 0x1F)
GREEN = RGBColor(0x22, 0xA0, 0x6B)
PURPLE = RGBColor(0x8B, 0x4F, 0xE0)

# 色块尺寸（居中偏上）
BOX_W = Inches(2.6)
BOX_H = Inches(2.6)
BOX_LEFT = Emu(int((SLIDE_W - BOX_W) / 2))
BOX_TOP = Emu(int((SLIDE_H - BOX_H) / 2 - Inches(0.4)))

# ---------- 2. 工具函数：添加带动画和切换的 slide ----------
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"

def add_title_text(slide, title):
    """在页面上方加一个标题文字。"""
    tx = slide.shapes.add_textbox(Inches(0.5), Inches(0.45), Inches(12.3), Inches(0.9))
    tf = tx.text_frame
    tf.margin_left = tf.margin_right = Emu(0)
    tf.margin_top = tf.margin_bottom = Emu(0)
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.LEFT
    r = p.add_run()
    r.text = title
    r.font.name = "PingFang SC"
    # East-Asian font hint
    rPr = r._r.get_or_add_rPr()
    ea = rPr.find(qn("a:ea"))
    if ea is None:
        ea = etree.SubElement(rPr, qn("a:ea"))
    ea.set("typeface", "PingFang SC")
    r.font.size = Pt(40)
    r.font.bold = True
    r.font.color.rgb = BLACK
    return tx

def add_brand_watermark(slide):
    """右下角小字品牌水印。"""
    tx = slide.shapes.add_textbox(Inches(10.6), Inches(7.0), Inches(2.5), Inches(0.4))
    tf = tx.text_frame
    tf.margin_left = tf.margin_right = Emu(0)
    tf.margin_top = tf.margin_bottom = Emu(0)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.RIGHT
    r = p.add_run()
    r.text = "童澄"
    r.font.name = "PingFang SC"
    rPr = r._r.get_or_add_rPr()
    ea = rPr.find(qn("a:ea"))
    if ea is None:
        ea = etree.SubElement(rPr, qn("a:ea"))
    ea.set("typeface", "PingFang SC")
    r.font.size = Pt(11)
    r.font.color.rgb = GREY

def add_color_box(slide, color, name, visible=True):
    """居中添加一个色块，返回 shape。"""
    box = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, BOX_LEFT, BOX_TOP, BOX_W, BOX_H)
    box.fill.solid()
    box.fill.fore_color.rgb = color
    box.line.fill.background()
    # 内部文字
    tf = box.text_frame
    tf.margin_left = tf.margin_right = Emu(0)
    tf.margin_top = tf.margin_bottom = Emu(0)
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = name
    r.font.name = "PingFang SC"
    rPr = r._r.get_or_add_rPr()
    ea = rPr.find(qn("a:ea"))
    if ea is None:
        ea = etree.SubElement(rPr, qn("a:ea"))
    ea.set("typeface", "PingFang SC")
    r.font.size = Pt(22)
    r.font.bold = True
    r.font.color.rgb = WHITE

    # 设置 shape 名称方便 spTree 索引
    box.name = name

    if not visible:
        # 默认隐藏：在 spPr 加 <a:ext uri="{...}"> 用 hidden=1，或者用 vanish
        spPr = box._element.spPr
        # python-pptx 没有直接 vanish，用 lxml 直接加
        # cNvPr 上加 hidden=1
        nv = box._element.find(qn("p:nvSpPr"))
        cNvPr = nv.find(qn("p:cNvPr"))
        cNvPr.set("hidden", "1")
    return box

def get_timing_node(slide):
    """获取/创建 <p:timing> 节点。"""
    cSld = slide._element.find(qn("p:cSld"))
    timing = cSld.find(qn("p:timing"))
    if timing is None:
        # 构造一个 timing 节点（PowerPoint 标准结构）
        timing = etree.SubElement(cSld, qn("p:timing"))
        # 必须的子节点：tnLst（事件分层）
        tnLst = etree.SubElement(timing, qn("p:tnLst"))
        # 根时间节点
        par = etree.SubElement(tnLst, qn("p:par"))
        par.set("id", "1")
        # 条件：nodeType = clickEffect
        cTn = etree.SubElement(par, qn("p:cTn"))
        cTn.set("id", "2")
        cTn.set("dur", "indefinite")
        cTn.set("restart", "never")
        cTn.set("nodeType", "clickEffect")
        # 启动条件（next click）
        etree.SubElement(cTn, qn("p:stCondLst")).append(
            etree.fromstring(
                f'<p:cond xmlns:p="{P_NS}" delay="0" evt="onClick"/>'
            )
        )
        return timing, par, cTn
    # 已存在 —— 拿到 par
    tnLst = timing.find(qn("p:tnLst"))
    par = tnLst.find(qn("p:par"))
    cTn = par.find(qn("p:cTn"))
    return timing, par, cTn

def add_animation(timing_par, anim_type, target_shape_id, color_from=None, scale_to=None):
    """
    在 timing_par 下追加一个子 par，包含 clickEffect。
    anim_type: 'fadeIn' | 'fadeOut' | 'grow' | 'wipeUp'
    """
    par = etree.SubElement(timing_par.getparent(), qn("p:par"))
    par.set("id", str(_next_anim_id()))
    cTn = etree.SubElement(par, qn("p:cTn"))
    cTn.set("id", str(_next_anim_id()))
    cTn.set("fill", "hold")
    # 启动条件：on click（在前一个动画之后）
    stCondLst = etree.SubElement(cTn, qn("p:stCondLst"))
    cond = etree.SubElement(stCondLst, qn("p:cond"))
    cond.set("delay", "0")
    cond.set("evt", "onClick")
    # 持续时间 0.8s
    set_node = etree.SubElement(cTn, qn("p:set"))
    set_node.set("ch", "0")
    set_node.set("bf", "0")
    # animateMotion / animateScale
    if anim_type == "fadeIn":
        anim = etree.SubElement(cTn, qn("p:anim"))
        anim.set("calcmode", "lin")
        anim.set("filter", "fade")
        anim.set("fill", "hold")
        # 关键帧
        t1 = etree.SubElement(anim, qn("p:t"))
        t1.set("tm", "0")
        # 透明度：0 -> 1（无 val 属性代表完全不透明）
        # PowerPoint 中 fade 用 strVal= opaque / transparent
        # 用 fld 列表
        etree.SubElement(t1, qn("p:fld")).set("fld", "1")
        t2 = etree.SubElement(anim, qn("p:t"))
        t2.set("tm", "800")
        etree.SubElement(t2, qn("p:fld")).set("fld", "0")
    elif anim_type == "fadeOut":
        anim = etree.SubElement(cTn, qn("p:anim"))
        anim.set("calcmode", "lin")
        anim.set("filter", "fade")
        anim.set("fill", "hold")
        t1 = etree.SubElement(anim, qn("p:t"))
        t1.set("tm", "0")
        etree.SubElement(t1, qn("p:fld")).set("fld", "0")
        t2 = etree.SubElement(anim, qn("p:t"))
        t2.set("tm", "800")
        etree.SubElement(t2, qn("p:fld")).set("fld", "1")
    elif anim_type == "grow":
        # animateScale
        anim = etree.SubElement(cTn, qn("p:anim"))
        anim.set("calcmode", "lin")
        anim.set("filter", "grow")
        anim.set("fill", "hold")
        t1 = etree.SubElement(anim, qn("p:t"))
        t1.set("tm", "0")
        # 50% 缩放
        s1 = etree.SubElement(t1, qn("p:r"))
        s1.set("x", "50000")
        s1.set("y", "50000")
        t2 = etree.SubElement(anim, qn("p:t"))
        t2.set("tm", "800")
        s2 = etree.SubElement(t2, qn("p:r"))
        s2.set("x", "150000")  # 1.5x
        s2.set("y", "150000")
    elif anim_type == "wipeUp":
        # 自下往上擦除：用 animateFilter + wipe filter
        # PowerPoint 的 wipe 出场 = 入场 = wipe，方向不同
        # 这里用 toRight 但翻转：实际用 dirY 负值
        # 简化：用 animMotion 直线上移 + 同时渐显
        anim = etree.SubElement(cTn, qn("p:animMotion"))
        anim.set("path", "pathM 0 0.5 L 0 0")
        anim.set("calcmode", "lin")
        anim.set("fill", "hold")
        t1 = etree.SubElement(anim, qn("p:t"))
        t1.set("tm", "0")
        # 没有 p:r 表示初始点
        t2 = etree.SubElement(anim, qn("p:t"))
        t2.set("tm", "800")
        r2 = etree.SubElement(t2, qn("p:r"))
        r2.set("x", "0")
        r2.set("y", "0")

    # target 节点
    target = etree.SubElement(par, qn("p:target"))
    tgtEl = etree.SubElement(target, qn("p:spTgt"))
    tgtEl.set("spid", str(target_shape_id))

# 全局 id 计数器
_anim_id_counter = [100]
def _next_anim_id():
    _anim_id_counter[0] += 1
    return _anim_id_counter[0]

def set_transition(slide, transition_type, direction=None, advance_on_click=True):
    """
    给 slide 加 p:transition。
    transition_type: 'push' | 'wipe' | 'fade' | 'split' | 'reveal' | 'cut' | ...
    direction: 'l'/'r'/'u'/'d'
    """
    cSld = slide._element.find(qn("p:cSld"))
    # 删除旧 transition
    for old in cSld.findall(qn("p:transition")):
        cSld.remove(old)
    trans = etree.SubElement(cSld, qn("p:transition"))
    if direction:
        trans.set("dir", direction)
    # spd（页面切换 vs 缓动）
    trans.set("spd", "med")
    # 启动方式：on click
    if advance_on_click:
        trans.set("advClick", "1")
    # 不自动
    trans.set("advTm", "0")
    inner = etree.SubElement(trans, qn(f"p:{transition_type}"))

# ---------- 3. 创建 4 页 ----------
# ---- Slide 1: 淡入 ----
s1 = prs.slides.add_slide(BLANK)
# 白底
bg = s1.background
bg.fill.solid()
bg.fill.fore_color.rgb = WHITE

add_title_text(s1, "淡入")
add_color_box(s1, BLUE, "淡入", visible=False)  # 默认不出现
# 1b. 加动画：淡入
timing, par, cTn = get_timing_node(s1)
box1 = s1.shapes[-1]
add_animation(par, "fadeIn", box1.shape_id)
# 切到下一张：推进，从右向左
set_transition(s1, "push", direction="r")
add_brand_watermark(s1)

# ---- Slide 2: 淡出 ----
s2 = prs.slides.add_slide(BLANK)
bg = s2.background
bg.fill.solid()
bg.fill.fore_color.rgb = WHITE
add_title_text(s2, "淡出")
add_color_box(s2, ORANGE, "淡出", visible=True)  # 先在
timing2, par2, cTn2 = get_timing_node(s2)
box2 = s2.shapes[-1]
add_animation(par2, "fadeOut", box2.shape_id)
# 切到下一张：擦除，自上而下
set_transition(s2, "wipe", direction="d")
add_brand_watermark(s2)

# ---- Slide 3: 放大缩小 ----
s3 = prs.slides.add_slide(BLANK)
bg = s3.background
bg.fill.solid()
bg.fill.fore_color.rgb = WHITE
add_title_text(s3, "放大缩小")
add_color_box(s3, GREEN, "放大", visible=True)  # 先在
timing3, par3, cTn3 = get_timing_node(s3)
box3 = s3.shapes[-1]
add_animation(par3, "grow", box3.shape_id)
# 切到下一张：淡出（页间淡入淡出）
set_transition(s3, "fade")
add_brand_watermark(s3)

# ---- Slide 4: 擦除 ----
s4 = prs.slides.add_slide(BLANK)
bg = s4.background
bg.fill.solid()
bg.fill.fore_color.rgb = WHITE
add_title_text(s4, "擦除")
add_color_box(s4, PURPLE, "擦除", visible=False)  # 默认不出现
timing4, par4, cTn4 = get_timing_node(s4)
box4 = s4.shapes[-1]
add_animation(par4, "wipeUp", box4.shape_id)
# 最后一张也加一个 p:transition（淡入），让每页都有 transition 节点
set_transition(s4, "fade")
add_brand_watermark(s4)

# ---------- 4. 保存 ----------
prs.save(OUT)
print(f"Saved: {OUT}")