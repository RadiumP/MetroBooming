#!/usr/bin/env python3
"""analyze_v3.py — 从 v3 导出的带标注 CSV 调优状态分类阈值。

用法:
  python3 analyze_v3.py metro-sensors-*.csv [--raw] [--feature train_intensity]

说明:
  - 只使用 mark 列非空、且已过校准窗口（elapsed_ms >= 20000）的样本。
  - 标签映射: 制动 -> 停站（减速中按低速度归入停站类）;
    步行 与 未标注 不参与阈值拟合（步行由独立启发式判定）。
  - 网格搜索 THRESHOLD_STOP / THRESHOLD_DEPART / THRESHOLD_CRUISE,
    使 停站 < 起步/低速 < 巡航 < 高速 的强度分桶与人工标注一致。
  - 默认用 train_intensity（平滑后，与页面实际分类一致）;
    --raw 改用 intensity_raw（瞬时值，用于对比）。
  - 输出可直接粘贴进 gps-accel-tester-v3.html 的 CONFIG.INFER。
"""
import csv
import json
import statistics
import sys
from collections import defaultdict

CALIBRATION_MS = 20000
CLASSES = ["停站", "起步", "巡航", "高速"]
CLASS_ID = {c: i for i, c in enumerate(CLASSES)}
ALIAS = {"制动": "停站"}  # 制动（减速中）按低速度归入停站类
SKIP = {"步行", ""}
DEFAULT_FEATURE = "train_intensity"


def load(paths):
    rows = []
    for p in paths:
        try:
            f = open(p, encoding="utf-8-sig")
        except OSError as e:
            print(f"警告: 无法打开 {p}: {e}", file=sys.stderr)
            continue
        with f:
            reader = csv.DictReader(f)
            for r in reader:
                try:
                    r["_elapsed"] = float(r.get("elapsed_ms") or "1e9")
                except ValueError:
                    r["_elapsed"] = 1e9
                rows.append(r)
    return rows


def usable(rows, feature):
    """返回 [(label_idx, intensity), ...]，只保留可用的标注样本。"""
    out = []
    for r in rows:
        mark = (r.get("mark") or "").strip()
        if mark in SKIP:
            continue
        label = CLASS_ID.get(mark)
        if label is None:
            label = CLASS_ID.get(ALIAS.get(mark, ""))
        if label is None:
            continue
        if r["_elapsed"] < CALIBRATION_MS:
            continue
        try:
            v = float(r.get(feature))
        except (TypeError, ValueError):
            continue
        out.append((label, v))
    return out


def bucket(v, t_stop, t_depart, t_cruise):
    if v < t_stop:
        return 0
    if v < t_depart:
        return 1
    if v < t_cruise:
        return 2
    return 3


def evaluate(pairs, t_stop, t_depart, t_cruise):
    correct = total = 0
    per = {c: [0, 0] for c in CLASSES}
    for label, v in pairs:
        pred = bucket(v, t_stop, t_depart, t_cruise)
        per[CLASSES[label]][1] += 1
        if pred == label:
            correct += 1
            per[CLASSES[label]][0] += 1
        total += 1
    return (correct / total) if total else 0.0, per


def grid_search(pairs):
    grid = [round(x / 100, 2) for x in range(5, 96, 5)]
    best = None
    for t_stop in grid:
        for t_depart in grid:
            if t_depart <= t_stop:
                continue
            for t_cruise in grid:
                if t_cruise <= t_depart:
                    continue
                acc, _ = evaluate(pairs, t_stop, t_depart, t_cruise)
                if best is None or acc > best[0]:
                    best = (acc, t_stop, t_depart, t_cruise)
    return best


def stats_by_label(pairs):
    by = defaultdict(list)
    for label, v in pairs:
        by[label].append(v)
    out = {}
    for c in CLASSES:
        vs = by[CLASS_ID[c]]
        out[c] = (len(vs), statistics.median(vs) if vs else None)
    return out


def main():
    args = list(sys.argv[1:])
    feature = DEFAULT_FEATURE
    if "--raw" in args:
        feature = "intensity_raw"
        args.remove("--raw")
    if "--feature" in args:
        i = args.index("--feature")
        if i + 1 < len(args):
            feature = args[i + 1]
            del args[i : i + 2]
    if not args:
        print(__doc__)
        sys.exit(1)

    rows = load(args)
    pairs = usable(rows, feature)
    if len(pairs) < 20:
        print(
            f"可用标注样本太少: {len(pairs)} 条（需要 >=20）。\n"
            "请先在 v3 页面里用状态按钮做好分段标注，再导出 CSV。"
        )
        sys.exit(2)

    print(f"使用特征: {feature}   有效标注样本: {len(pairs)}")
    print("--- 各状态分布（数量 / 强度中位数）---")
    for c, (n, med) in stats_by_label(pairs).items():
        med_s = f"{med:.3f}" if med is not None else "-"
        print(f"  {c}: n={n:5d}  median={med_s}")

    acc, t_stop, t_depart, t_cruise = grid_search(pairs)
    _, per = evaluate(pairs, t_stop, t_depart, t_cruise)
    print("--- 最优阈值（网格搜索）---")
    print(f"  THRESHOLD_STOP   = {t_stop:.2f}")
    print(f"  THRESHOLD_DEPART = {t_depart:.2f}")
    print(f"  THRESHOLD_CRUISE = {t_cruise:.2f}")
    print(f"  整体准确率: {acc * 100:.1f}%")
    print("--- 按标注类别的正确率 ---")
    for c, (ok, n) in per.items():
        print(f"  {c}: {ok}/{n} = {ok / n * 100 if n else 0:.0f}%")
    print("--- 建议 CONFIG.INFER 配置（可粘贴进 v3）---")
    print(
        json.dumps(
            {
                "THRESHOLD_STOP": t_stop,
                "THRESHOLD_DEPART": t_depart,
                "THRESHOLD_CRUISE": t_cruise,
                "NOTE": "由 analyze_v3.py 在标注数据上网格搜索得到",
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
