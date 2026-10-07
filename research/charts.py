"""Builds docs/img/*.png and research/results/summary.json from research/results/*.json."""
import json, os, statistics as st
from collections import Counter, defaultdict
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

R = os.path.join(os.path.dirname(__file__), "results")
IMG = os.path.join(os.path.dirname(__file__), "..", "docs", "img")
load = lambda n: json.load(open(os.path.join(R, n)))

SURFACE, INK, INK2, MUTED, GRID, AXIS = "#fcfcfb", "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7"
S1, S2, S3 = "#2a78d6", "#eb6834", "#1baf7a"
GOOD, CRIT = "#0ca30c", "#d03b3b"
plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "font.family": "DejaVu Sans", "font.size": 10, "text.color": INK, "axes.labelcolor": INK2,
    "axes.edgecolor": AXIS, "xtick.color": MUTED, "ytick.color": INK2, "axes.titleweight": "bold",
    "axes.titlesize": 12, "axes.titlelocation": "left", "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.axisbelow": True, "legend.frameon": False,
})
summary = {}

def save(fig, name):
    for ax in fig.axes:
        title = ax.get_title(loc="left")
        if title:
            ax.set_title("", loc="left")
            fig.suptitle(title, x=0.015, ha="left", fontsize=12, fontweight="bold", color=INK)
    fig.tight_layout()
    fig.savefig(os.path.join(IMG, name), dpi=150)
    plt.close(fig)

def hbars(ax, labels, series, names, colors, fmt="{:.0f}", xmax=None, log=False):
    n = len(series); h = 0.8 / n
    for k, (vals, name, c) in enumerate(zip(series, names, colors)):
        ys = [i + (k - (n - 1) / 2) * h for i in range(len(labels))]
        bars = ax.barh(ys, vals, height=h * 0.85, color=c, label=name, edgecolor=SURFACE, linewidth=1)
        for y, v in zip(ys, vals):
            ax.text(max(v, 1) * 1.12 if log else v + (xmax or max(max(s) for s in series)) * 0.01, y, fmt.format(v), va="center", fontsize=8, color=INK2)
    ax.set_yticks(range(len(labels)), labels)
    ax.invert_yaxis(); ax.grid(axis="y", visible=False)
    if xmax: ax.set_xlim(0, xmax)
    if n > 1: ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.16 if log else -0.2), ncol=n, fontsize=9)

# ---------- tests & coverage ----------
vt = load("vitest.json")
per_file = sorted(((os.path.relpath(f["name"], os.path.join(os.path.dirname(__file__), "..")).replace("test/", ""), len(f["assertionResults"])) for f in vt["testResults"]), key=lambda x: -x[1])
cov = json.load(open(os.path.join(os.path.dirname(__file__), "..", "coverage", "coverage-summary.json")))
summary["tests"] = {"total": vt["numTotalTests"], "passed": vt["numPassedTests"], "failed": vt["numFailedTests"], "files": len(vt["testResults"]),
                    "coverage": {k: cov["total"][k]["pct"] for k in ("lines", "statements", "functions", "branches")}}
fig, ax = plt.subplots(figsize=(8, 4.6))
hbars(ax, [p for p, _ in per_file], [[n for _, n in per_file]], ["Тесты"], [S1])
ax.set_title(f"Тесты по наборам — всего {vt['numTotalTests']}, пройдено {vt['numPassedTests']}")
ax.set_xlabel("Количество тестов")
save(fig, "tests-per-suite.png")

groups = defaultdict(lambda: {"lines": [0, 0], "branches": [0, 0]})
for path, v in cov.items():
    if path == "total": continue
    g = os.path.relpath(os.path.dirname(path), os.path.join(os.path.dirname(__file__), ".."))
    for m in ("lines", "branches"):
        groups[g][m][0] += v[m]["covered"]; groups[g][m][1] += v[m]["total"]
names = sorted(groups)
fig, ax = plt.subplots(figsize=(8, 3.6))
hbars(ax, names, [[100 * groups[g]["lines"][0] / groups[g]["lines"][1] for g in names], [100 * groups[g]["branches"][0] / max(1, groups[g]["branches"][1]) for g in names]],
      ["Строки", "Ветки"], [S1, S2], fmt="{:.1f}%", xmax=112)
ax.set_title(f"Покрытие кода: строки {cov['total']['lines']['pct']}%, ветки {cov['total']['branches']['pct']}%")
ax.set_xlabel("%")
save(fig, "coverage.png")

# ---------- R1 AI review ----------
r1, r1f, r1b, r1a = load("r1-ai-review.json"), load("r1-ai-review-fallback.json"), load("r1b-prompt-ab.json"), load("r1-ai-review-after.json")
def metrics(rows):
    tp = sum(1 for r in rows if not r["ok"] and not r["accepted"]); fn = sum(1 for r in rows if not r["ok"] and r["accepted"])
    fp = sum(1 for r in rows if r["ok"] and not r["accepted"]); tn = sum(1 for r in rows if r["ok"] and r["accepted"])
    return {"n": len(rows), "accuracy": (tp + tn) / len(rows), "rework_recall": tp / (tp + fn), "rework_precision": tp / (tp + fp) if tp + fp else 0,
            "false_rework_rate": fp / (fp + tn), "tp": tp, "fn": fn, "fp": fp, "tn": tn,
            "latency_ms": {"p50": st.median(r["ms"] for r in rows), "p95": sorted(r["ms"] for r in rows)[int(0.95 * len(rows)) - 1], "mean": st.mean(r["ms"] for r in rows)}}
def consistency(rows):
    by = defaultdict(list)
    for r in rows: by[r["id"]].append(r["accepted"])
    return sum(1 for v in by.values() if len(set(v)) == 1) / len(by)
is_english = lambda r: sum(c.isascii() and c.isalpha() for c in r["explanation"]) > 0.5 * max(1, sum(c.isalpha() for c in r["explanation"]))
summary["r1"] = {"rules_only": metrics(r1f), "llm_current": metrics(r1), "llm_improved_prompt": metrics(r1b), "after_fix": metrics(r1a),
                 "consistency_current": consistency(r1), "consistency_improved": consistency(r1b), "consistency_after": consistency(r1a),
                 "english_after": sum(1 for r in r1a if is_english(r)), "verdicts_after": Counter(r["verdict"] for r in r1a),
                 "english_explanations": sum(1 for r in r1 if sum(c.isascii() and c.isalpha() for c in r["explanation"]) > 0.5 * max(1, sum(c.isalpha() for c in r["explanation"]))),
                 "verdicts_current": Counter(r["verdict"] for r in r1)}
fig, ax = plt.subplots(figsize=(8, 3.4))
labels = ["Точность (accuracy)", "Полнота доработок (recall)", "Ложные доработки"]
vals = lambda m: [100 * m["accuracy"], 100 * m["rework_recall"], 100 * m["false_rework_rate"]]
hbars(ax, labels, [vals(summary["r1"]["rules_only"]), vals(summary["r1"]["llm_current"]), vals(summary["r1"]["after_fix"])],
      ["Только правила (без LLM)", "До исправления", "После исправления"], [MUTED, S2, S1], fmt="{:.1f}%", xmax=118)
ax.set_title("AI-проверка закрытия: 24 кейса × 3 прогона, реальный код")
ax.set_xlabel("%")
save(fig, "ai-review-quality.png")

kinds = list(dict.fromkeys(r["kind"] for r in r1))
acc_kind = lambda rows, k: 100 * st.mean(r["correct"] for r in rows if r["kind"] == k)
fig, ax = plt.subplots(figsize=(8, 4.8))
hbars(ax, kinds, [[acc_kind(r1, k) for k in kinds], [acc_kind(r1a, k) for k in kinds]], ["До исправления", "После исправления"], [S2, S1], fmt="{:.0f}%", xmax=115)
ax.set_title("Верные вердикты по типам отчётов")
ax.set_xlabel("% верных вердиктов")
save(fig, "ai-review-by-kind.png")

fig, ax = plt.subplots(figsize=(8, 3))
ax.hist([r["ms"] / 1000 for r in r1a], bins=20, color=S1, edgecolor=SURFACE, linewidth=2)
ax.set_title("Время AI-проверки одного наряда после исправления (gpt-oss:20b, RTX 3090)")
ax.set_xlabel("секунды"); ax.set_ylabel("нарядов"); ax.grid(axis="x", visible=False)
save(fig, "ai-review-latency.png")

# ---------- R2 intents ----------
llm, kw, llma, kwa = load("r2-intents-llm.json"), load("r2-intents-keywords.json"), load("r2-intents-llm-after.json"), load("r2-intents-keywords-after.json")
intents = list(dict.fromkeys(r["expected"] for r in llm))
acc = lambda rows, f: 100 * st.mean(r["correct"] for r in rows if f(r))
summary["r2"] = {"n": len(llm), "llm_accuracy": acc(llm, lambda r: True), "keyword_accuracy": acc(kw, lambda r: True),
                 "llm_ru": acc(llm, lambda r: r["lang"] == "ru"), "llm_kk": acc(llm, lambda r: r["lang"] == "kk"),
                 "kw_ru": acc(kw, lambda r: r["lang"] == "ru"), "kw_kk": acc(kw, lambda r: r["lang"] == "kk"),
                 "llm_latency_ms": {"p50": st.median(r["ms"] for r in llm), "max": max(r["ms"] for r in llm)},
                 "errors": [{"message": r["message"], "expected": r["expected"], "predicted": r["predicted"]} for r in llm if not r["correct"]],
                 "after": {"llm_accuracy": acc(llma, lambda r: True), "keyword_accuracy": acc(kwa, lambda r: True),
                           "llm_ru": acc(llma, lambda r: r["lang"] == "ru"), "llm_kk": acc(llma, lambda r: r["lang"] == "kk"),
                           "kw_ru": acc(kwa, lambda r: r["lang"] == "ru"), "kw_kk": acc(kwa, lambda r: r["lang"] == "kk"),
                           "llm_latency_ms": {"p50": st.median(r["ms"] for r in llma), "max": max(r["ms"] for r in llma)},
                           "errors": [{"message": r["message"], "expected": r["expected"], "predicted": r["predicted"]} for r in llma if not r["correct"]],
                           "kw_errors": [{"message": r["message"], "expected": r["expected"], "predicted": r["predicted"]} for r in kwa if not r["correct"]]}}
fig, ax = plt.subplots(figsize=(8, 5.2))
per = lambda rows: [acc(rows, lambda r, i=i: r["expected"] == i) for i in intents] + [acc(rows, lambda r: r["lang"] == "ru"), acc(rows, lambda r: r["lang"] == "kk")]
hbars(ax, intents + ["Русский (30)", "Казахский (6)"], [per(llm), per(llma), per(kwa)],
      ["LLM до", "LLM после", "Ключевые слова после"], [S2, S1, MUTED], fmt="{:.0f}%", xmax=115)
ax.set_title(f"Классификация запросов помощника: LLM {summary['r2']['llm_accuracy']:.1f}% → {summary['r2']['after']['llm_accuracy']:.1f}%")
ax.set_xlabel("% верно определённых намерений")
save(fig, "assistant-intents.png")

# ---------- R3 whisper ----------
w = load("r3-whisper.json")
snrs = [None, 20, 10, 5]; lab = ["чисто", "20 дБ", "10 дБ", "5 дБ"]
werv = [100 * st.mean(r["wer"] for r in w if r["snr"] == s) for s in snrs]
cerv = [100 * st.mean(r["cer"] for r in w if r["snr"] == s) for s in snrs]
summary["r3"] = {"clips": len(w), "by_snr": {l: {"wer": a, "cer": b, "exact": 100 * st.mean(r["wer"] == 0 for r in w if r["snr"] == s)} for l, a, b, s in zip(lab, werv, cerv, snrs)},
                 "latency_ms_p50": st.median(r["ms"] for r in w), "rtf_p50": st.median(r["rtf"] for r in w),
                 "by_voice_clean_wer": {v: 100 * st.mean(r["wer"] for r in w if r["voice"] == v and r["snr"] is None) for v in sorted({r["voice"] for r in w})}}
fig, ax = plt.subplots(figsize=(8, 3.4))
for vals, name, c in ((werv, "WER (слова)", S1), (cerv, "CER (символы)", S2)):
    ax.plot(lab, vals, color=c, linewidth=2, marker="o", markersize=7, markeredgecolor=SURFACE, markeredgewidth=2, label=name)
    ax.annotate(f"{vals[-1]:.1f}%", (3, vals[-1]), textcoords="offset points", xytext=(8, -3), fontsize=9, color=INK2)
    ax.annotate(f"{vals[0]:.1f}%", (0, vals[0]), textcoords="offset points", xytext=(4, 9), ha="left", fontsize=9, color=INK2)
ax.set_ylim(0, max(werv) * 1.25); ax.set_ylabel("ошибка, %"); ax.set_xlabel("уровень шума (SNR)")
ax.set_title("Whisper large-v3: ошибка распознавания от шума (80 фраз на уровень)")
ax.legend(loc="upper left"); ax.grid(axis="x", visible=False)
save(fig, "whisper-wer.png")

# ---------- R4 phash ----------
p = load("r4-phash.json")
fig, ax = plt.subplots(figsize=(8, 3.4))
th = [s["threshold"] for s in p["sweep"]]
ax.plot(th, [100 * s["tpr"] for s in p["sweep"]], color=S1, linewidth=2, label="Найдено повторов (TPR)")
ax.plot(th, [100 * s["fpr"] for s in p["sweep"]], color=S2, linewidth=2, label="Ложные срабатывания (FPR)")
for x, txt in ((0.98, "0.98: автодоработка"), (0.88, "0.88: на проверку мастеру")):
    ax.axvline(x, color=MUTED, linewidth=1, linestyle="--")
    ax.text(x - 0.004, 50, txt, rotation=90, va="center", ha="right", fontsize=8, color=INK2)
ax.set_xlabel("порог сходства"); ax.set_ylabel("%"); ax.legend(loc="center left")
ax.set_title("Перцептивный хеш фото: выбор порога (720 пар повтора, 240 разных)")
save(fig, "phash-threshold.png")
best = max(p["sweep"], key=lambda s: s["tpr"] - s["fpr"] * 10)
summary["r4"] = {"byPair": p["byPair"], "at_098": next(s for s in p["sweep"] if s["threshold"] == 0.98), "at_088": next(s for s in p["sweep"] if s["threshold"] == 0.88),
                 "max_different": max(r["sim"] for r in p["rows"] if r["kind"] == "different")}
bp = p["byPair"]
fig, ax = plt.subplots(figsize=(8, 4))
lbl = [b["pair"] for b in bp]
at90 = [100 * sum(1 for r in p["rows"] if r["pair"] == b["pair"] and r["sim"] > 0.88) / b["n"] for b in bp]
hbars(ax, lbl, [[100 * b["detected"] for b in bp], at90], ["≥ 0.98: автоматическая доработка", "≥ 0.88: на проверку мастеру"], [S1, S3], fmt="{:.0f}%", xmax=115)
ax.set_title("Какие подмены фото распознаются как повтор")
ax.set_xlabel("% пар, помеченных как повтор («другое фото» = ложные срабатывания)", fontsize=9)
save(fig, "phash-by-transform.png")

# ---------- R5 load ----------
L, L0 = load("r5-load-after.json"), load("r5-load.json")
eps = list(dict.fromkeys(r["name"] for r in L))
at = lambda c, k: [next(r[k] for r in L if r["name"] == e and r["connections"] == c) for e in eps]
summary["r5"] = {"after": L, "before": L0}
fig, ax = plt.subplots(figsize=(8, 4.6))
hbars(ax, eps, [at(10, "rps")], ["RPS"], [S1], fmt="{:.0f}", log=True)
ax.set_xscale("symlog", linthresh=10); ax.set_xlim(0, 6000)
ax.set_title("Пропускная способность, 10 параллельных соединений (запросов/с)")
ax.set_xlabel("запросов в секунду (лог. шкала)")
save(fig, "load-rps.png")
fig, ax = plt.subplots(figsize=(8, 4.6))
hbars(ax, eps, [at(1, "p50"), at(10, "p99"), at(50, "p99")], ["p50, 1 соединение", "p99, 10 соединений", "p99, 50 соединений"], [S3, S1, S2], fmt="{:.0f}", log=True)
ax.set_xscale("symlog", linthresh=10); ax.set_xlim(0, 20000)
ax.set_title("Задержка ответа, мс")
ax.set_xlabel("мс (лог. шкала)")
save(fig, "load-latency.png")

# ---------- R6 analytics ----------
a0, a = load("r6-analytics.json"), load("r6-analytics-after.json")
top = a["perEquipment"][:10]
fig, ax = plt.subplots(figsize=(8, 3.6))
cols = [S2 if t["name"] == "Конвейер К-3" else S1 for t in top]
ax.barh([t["name"] for t in top], [t["n"] for t in top], color=cols, edgecolor=SURFACE, linewidth=2)
for i, t in enumerate(top): ax.text(t["n"] + 1, i, str(t["n"]), va="center", fontsize=8, color=INK2)
ax.invert_yaxis(); ax.grid(axis="y", visible=False)
ax.set_title("Нарядов на оборудование, топ-10 (оранжевый — заложенная аномалия)")
ax.set_xlabel("нарядов за 90 дней")
save(fig, "seed-equipment.png")
types = Counter(x["type"] for x in a["anomalies"])
types0 = Counter(x["type"] for x in a0["anomalies"])
tnames = ["FREQUENT_FAILURES", "REPEATED_FAULT", "FAILURE_AFTER_PLANNED_MAINTENANCE", "MATERIAL_ANOMALY"]
fig, ax = plt.subplots(figsize=(8, 3.4))
hbars(ax, ["Частые отказы", "Повторяющийся шифр", "Отказы после ППР", "Расход материалов"], [[types0.get(t, 0) for t in tnames], [types.get(t, 0) for t in tnames]],
      ["До исправления", "После исправления"], [S2, S1], fmt="{:.0f}", xmax=30)
ax.set_title(f"Сигналов аномалий на демо-данных: {len(a0['anomalies'])} → {len(a['anomalies'])}")
ax.set_xlabel("количество сигналов")
save(fig, "anomalies-before-after.png")
summary["r6_before"] = {"anomalies": len(a0["anomalies"]), "anomalyTypes": types0, "falsePositives": a0["falsePositives"], "plantedDetected": a0["plantedDetected"],
                       "k3Forecast": next((f for f in a0["forecast"] if f["equipment"] == "Конвейер К-3"), None), "forecastTop": a0["forecast"][:3]}
summary["r6"] = {"forecastTop": a["forecast"][:5], "totalOrders": a["totalOrders"], "onTimeRate": a["onTimeRate"], "verdicts": a["verdicts"], "anomalies": len(a["anomalies"]), "anomalyTypes": types,
                 "plantedDetected": a["plantedDetected"], "falsePositives": a["falsePositives"], "anomalyMs": a["anomalyMs"],
                 "forecastSaturated": sum(1 for f in a["forecast"] if f["probability"] >= 0.95), "forecastTotal": len(a["forecast"]),
                 "k3Forecast": next((f for f in a["forecast"] if f["equipment"] == "Конвейер К-3"), None),
                 "ratings": a["ratings"], "brigades": a["brigades"], "dashboard": a["dashboard"]}
fig, ax = plt.subplots(figsize=(8, 4.2))
rt = a["ratings"]
cols = [S2 if r["fullName"] == "Исполнитель 1" else S1 for r in rt]
ax.barh([r["fullName"] for r in rt], [r["score"] for r in rt], color=cols, edgecolor=SURFACE, linewidth=2)
for i, r in enumerate(rt): ax.text(r["score"] + 0.8, i, f"{r['score']:.1f}", va="center", fontsize=8, color=INK2)
ax.invert_yaxis(); ax.grid(axis="y", visible=False); ax.set_xlim(0, 105)
ax.set_title("Рейтинг исполнителей на демо-данных\n(оранжевый — заложенное низкое качество)")
ax.set_xlabel("балл рейтинга (0–100)")
save(fig, "ratings.png")


# ---------- R7 RAG self-learning ----------
if os.path.exists(os.path.join(R, "r7-rag-review.json")):
    rv = load("r7-rag-review.json")
    stages = list(dict.fromkeys(r["stage"] for r in rv))
    pct = lambda rows, f=lambda r: r["correct"]: round(100 * sum(1 for r in rows if f(r)) / len(rows), 1) if rows else None
    r7 = {"stages": []}
    for st_ in stages:
        rows = [r for r in rv if r["stage"] == st_]
        plant = [r for r in rows if r["group"] != "R1-контроль"]
        # HG3/HG4 break plant rules P3/P5 (see r7-rag.ts): reported apart, not as control errors.
        conflict = [r for r in rows if r["id"] in ("HG3", "HG4")]
        ctrl = [r for r in rows if r["group"] == "R1-контроль" and r["id"] not in ("HG3", "HG4")]
        r7["stages"].append({
            "stage": st_, "memory": rows[0]["memory"],
            "plantAccuracy": pct(plant), "plantBadCaught": pct([r for r in plant if not r["ok"]]), "plantGoodAccepted": pct([r for r in plant if r["ok"]]),
            "controlAccuracy": pct(ctrl), "controlBadCaught": pct([r for r in ctrl if not r["ok"]]), "controlGoodAccepted": pct([r for r in ctrl if r["ok"]]),
            "conflictReworked": pct(conflict, lambda r: not r["accepted"]),
            "withPrecedents": pct(rows, lambda r: r["precedents"] > 0),
            "topIsSameRule": pct([r for r in plant if r["topRule"]], lambda r: r["topRule"] == r["group"]),
            "needsMasterReview": pct(rows, lambda r: r["needsMasterReview"]),
            "msMedian": st.median(r["ms"] for r in rows),
            "byRule": {g: pct([r for r in plant if r["group"] == g]) for g in dict.fromkeys(r["group"] for r in plant)},
        })
    summary["r7"] = r7
    xs = range(len(stages))
    labels = [s_.replace(" решения мастера на правило", "\nрешения на правило").replace("история завода", "история\nзавода").replace("без памяти", "без\nпамяти") for s_ in stages]
    fig, ax = plt.subplots(figsize=(8, 4.2))
    for key, name, c in [("plantAccuracy", "Заводские правила: верные вердикты", S1), ("plantBadCaught", "Заводские правила: найдено плохих", S2), ("controlAccuracy", "Общие критерии (R1, контроль): верные", S3)]:
        ys = [x[key] for x in r7["stages"]]
        ax.plot(xs, ys, marker="o", color=c, linewidth=2, label=name)
        for x, y in zip(xs, ys): ax.text(x, y + 2.5, f"{y:.0f}%", ha="center", fontsize=8, color=c)
    ax.set_xticks(list(xs), labels, fontsize=8); ax.set_ylim(0, 110); ax.set_ylabel("%")
    ax.set_title("Самообучение AI-проверки через RAG-память")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.2), ncol=2, fontsize=8)
    save(fig, "rag-learning-curve.png")
    rules = list(r7["stages"][0]["byRule"])
    fig, ax = plt.subplots(figsize=(8, 3.8))
    hbars(ax, rules, [[r7["stages"][0]["byRule"][g] for g in rules], [r7["stages"][-1]["byRule"][g] for g in rules]],
          ["без памяти", stages[-1]], [S2, S1], fmt="{:.0f}%", xmax=115)
    ax.set_title("Верные вердикты по заводским правилам")
    ax.set_xlabel("% верных вердиктов")
    save(fig, "rag-by-rule.png")
if os.path.exists(os.path.join(R, "r7-rag-fault.json")):
    fr = load("r7-rag-fault.json")
    conds = list(dict.fromkeys(r["condition"] for r in fr))
    acc = {c: round(100 * sum(r["correct"] for r in fr if r["condition"] == c) / sum(1 for r in fr if r["condition"] == c), 1) for c in conds}
    summary.setdefault("r7", {})["fault"] = {"cases": len({r["description"] for r in fr}), "accuracy": acc,
        "msMedian": {c: st.median(r["ms"] for r in fr if r["condition"] == c) for c in conds}}
    fig, ax = plt.subplots(figsize=(8, 2.6))
    hbars(ax, conds, [[acc[c] for c in conds]], ["% верных шифров"], [S1], fmt="{:.1f}%", xmax=110)
    ax.set_title(f"Подбор шифра неисправности по описанию ({len({r['description'] for r in fr})} новых описаний)")
    ax.set_xlabel("% верных шифров")
    save(fig, "rag-fault.png")

json.dump(summary, open(os.path.join(R, "summary.json"), "w"), ensure_ascii=False, indent=1, default=str)
print(json.dumps({k: v for k, v in summary.items() if k not in ("r5",)}, ensure_ascii=False, indent=1, default=str)[:6000])
