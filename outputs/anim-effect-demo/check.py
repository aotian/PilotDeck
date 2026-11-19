#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
检查 pptx 的真实结构：
- 页数
- 哪些页有 p:timing（含 anim 节点）
- 哪些页有 p:transition
"""
import zipfile
import re
from pathlib import Path

PPTX = "/Users/tongcheng/Projects/PilotDeck/outputs/anim-effect-demo/动画效果测试.pptx"
OUT_TXT = "/Users/tongcheng/Projects/PilotDeck/outputs/anim-effect-demo/check.txt"

lines = []
lines.append("=" * 60)
lines.append("动画效果测试.pptx 检查报告")
lines.append("=" * 60)
lines.append(f"文件: {PPTX}")
lines.append(f"大小: {Path(PPTX).stat().st_size} bytes")
lines.append("")

with zipfile.ZipFile(PPTX, "r") as z:
    slide_files = sorted(
        [n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)],
        key=lambda x: int(re.search(r"slide(\d+)\.xml", x).group(1)),
    )
    lines.append(f"幻灯片页数: {len(slide_files)}")
    lines.append("")

    has_timing = []
    has_transition = []
    anim_details = []
    trans_details = []

    for sf in slide_files:
        idx = int(re.search(r"slide(\d+)\.xml", sf).group(1))
        xml = z.read(sf).decode("utf-8")

        # p:timing 节点
        m_timing = re.search(r"<p:timing[\s>]", xml)
        # p:transition 节点
        m_trans = re.search(r"<p:transition[\s>]", xml)
        # 动画节点统计
        n_anim = len(re.findall(r"<p:anim\b", xml))
        n_animMotion = len(re.findall(r"<p:animMotion\b", xml))
        n_clickCond = len(re.findall(r'<p:cond[^/]*evt="onClick"', xml))
        n_par = len(re.findall(r"<p:par\b", xml))
        # transition 类型
        trans_types = re.findall(r"<p:(push|wipe|fade|cut|cov[er]+)[^>]*>", xml)

        slide_info = {
            "idx": idx,
            "has_timing": bool(m_timing),
            "has_transition": bool(m_trans),
            "n_anim": n_anim,
            "n_animMotion": n_animMotion,
            "n_clickCond": n_clickCond,
            "n_par": n_par,
            "trans_types": trans_types,
        }

        if m_timing:
            has_timing.append(idx)
        if m_trans:
            has_transition.append(idx)

        anim_details.append(slide_info)
        lines.append(
            f"Slide {idx}: timing={'Y' if m_timing else 'N'} "
            f"transition={'Y' if m_trans else 'N'} "
            f"anim={n_anim} animMotion={n_animMotion} "
            f"clickCond={n_clickCond} par={n_par} "
            f"transType={trans_types}"
        )

    lines.append("")
    lines.append("=" * 60)
    lines.append("汇总")
    lines.append("=" * 60)
    lines.append(f"总页数: {len(slide_files)}")
    lines.append(f"含 p:timing 的页: {has_timing}  (共 {len(has_timing)} 页)")
    lines.append(f"含 p:transition 的页: {has_transition}  (共 {len(has_transition)} 页)")
    lines.append("")

    # 详细列出每一页的动画/切换细节
    lines.append("=" * 60)
    lines.append("每页动画/切换细节")
    lines.append("=" * 60)
    for s in anim_details:
        lines.append("")
        lines.append(f"--- Slide {s['idx']} ---")
        lines.append(f"  p:timing: {'存在' if s['has_timing'] else '缺失'}")
        lines.append(f"  p:transition: {'存在' if s['has_transition'] else '缺失'}")
        lines.append(f"  p:anim 数量: {s['n_anim']}")
        lines.append(f"  p:animMotion 数量: {s['n_animMotion']}")
        lines.append(f"  click 触发条件数量: {s['n_clickCond']}")
        lines.append(f"  transition 类型: {s['trans_types']}")

    # 关键判定
    lines.append("")
    lines.append("=" * 60)
    lines.append("判定")
    lines.append("=" * 60)
    ok_pages = [s["idx"] for s in anim_details if s["has_timing"] and s["has_transition"]]
    if len(ok_pages) == len(slide_files):
        lines.append(f"PASS: 全部 {len(slide_files)} 页都同时包含 p:timing 与 p:transition")
    else:
        bad = [s["idx"] for s in anim_details if not (s["has_timing"] and s["has_transition"])]
        lines.append(f"FAIL: 以下页缺少 p:timing 或 p:transition: {bad}")

    # 输出到文件
    report = "\n".join(lines)
    Path(OUT_TXT).write_text(report, encoding="utf-8")
    print(report)
    print(f"\n检查报告已写入: {OUT_TXT}")