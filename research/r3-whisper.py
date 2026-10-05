"""WER/CER of the deployed whisper-service on synthesized Russian maintenance phrases (Piper voices) with added noise."""
import io, json, os, re, time, wave
import numpy as np
import requests
import soundfile as sf
from piper import PiperVoice

VOICES_DIR = "/www/wwwroot/piper-service/voices"
WHISPER = os.environ.get("WHISPER", "http://127.0.0.1:8090/transcribe")
OUT = os.path.join(os.path.dirname(__file__), "results", "r3-whisper.json")
PHRASES = [
    "Заменить подшипник на насосе первого участка",
    "Течь сальника, требуется замена набивки",
    "Конвейер остановлен, сход ленты вправо",
    "Повышенная вибрация дробилки, проверить амортизаторы",
    "Перегрев редуктора, заменить масло и очистить сапун",
    "Сгорел предохранитель в цепи управления двигателем",
    "Износ футеровки, нужна замена плит",
    "Порыв ленты, выполнить вулканизацию стыка",
    "Утечка масла из гидросистемы под высоким давлением",
    "Срабатывает защита электродвигателя при пуске",
    "Работы выполнены, оборудование проверено под нагрузкой",
    "Заменены роликоопоры, лента идёт по центру",
    "Нет допуска, работу приостанавливаю",
    "Отказываюсь, нет материалов на складе",
    "Подтянуты анкерные болты, вибрация в норме",
    "Проверена изоляция мегаомметром, замечаний нет",
    "Требуется сварщик для ремонта рамы конвейера",
    "Аварийная остановка насоса, срочно нужен электрик",
    "Смазка подшипников выполнена согласно графику",
    "Шум в редукторе усилился после планового ремонта",
]
SNRS = [None, 20, 10, 5]  # None = clean

def norm(s):
    s = s.lower().replace("ё", "е")
    s = re.sub(r"[^\w\s]", " ", s)
    return s.split()

def lev(a, b):
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
            prev = cur
    return d[len(b)]

rng = np.random.default_rng(42)
rows = []
for vf in sorted(f for f in os.listdir(VOICES_DIR) if f.endswith(".onnx")):
    voice = PiperVoice.load(os.path.join(VOICES_DIR, vf))
    sr = voice.config.sample_rate
    name = vf.split("-")[1]
    for text in PHRASES:
        audio = np.concatenate([c.audio_float_array for c in voice.synthesize(text)])
        for snr in SNRS:
            x = audio
            if snr is not None:
                p = np.mean(audio ** 2)
                x = audio + rng.normal(0, np.sqrt(p / 10 ** (snr / 10)), audio.shape)
                x = np.clip(x, -1, 1)
            buf = io.BytesIO()
            sf.write(buf, x.astype(np.float32), sr, format="WAV", subtype="PCM_16")
            t = time.perf_counter()
            r = requests.post(WHISPER, params={"language": "ru"}, files={"file": ("a.wav", buf.getvalue(), "audio/wav")}, timeout=120)
            ms = (time.perf_counter() - t) * 1000
            hyp = r.json().get("text", "")
            ref_w, hyp_w = norm(text), norm(hyp)
            ref_c, hyp_c = " ".join(ref_w), " ".join(hyp_w)
            dur = len(x) / sr
            rows.append({"voice": name, "snr": snr, "ref": text, "hyp": hyp, "wer": lev(ref_w, hyp_w) / len(ref_w),
                         "cer": lev(ref_c, hyp_c) / len(ref_c), "ms": ms, "duration": dur, "rtf": ms / 1000 / dur})
            print(f"{name:7} snr={str(snr):4} wer={rows[-1]['wer']:.2f} {ms:6.0f}ms | {hyp}")
json.dump(rows, open(OUT, "w"), ensure_ascii=False, indent=1)
