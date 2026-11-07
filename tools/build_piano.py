# Salamander Grand Piano（FLAC）から、アプリで使う音源を作る
#   python tools/build_piano.py <FLAC のフォルダ>
#   → sounds/piano/*.mp3 と js/audio/pianodata.js（強さごとの音量の表）
#
# やること：
#   ・音の始まりを先頭にそろえる（押してから鳴るまでの遅れをなくす）
#   ・高さごとの音量のばらつきをならす（元の録音は同じ強さでも音ごとに最大 ±8 dB ほど違う）
#   ・長さを切り詰めて、最後はなめらかに消す（ダウンロードとメモリを抑える）
# PC に負担をかけないよう、優先度を下げて 1 ファイルずつ処理する。
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

if os.name == 'nt':
    import ctypes
    ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)  # 通常以下

SRC = sys.argv[1]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'sounds', 'piano')
DATA = os.path.join(ROOT, 'js', 'audio', 'pianodata.js')

NAMES = ['A0', 'C1', 'D#1', 'F#1', 'A1', 'C2', 'D#2', 'F#2', 'A2', 'C3', 'D#3', 'F#3', 'A3', 'C4', 'D#4', 'F#4', 'A4', 'C5', 'D#5', 'F#5', 'A5', 'C6', 'D#6', 'F#6', 'A6', 'C7', 'D#7', 'F#7', 'A7', 'C8']
MIDI = [21 + 3 * i for i in range(30)]
LAYERS = [1, 4, 7, 10, 13, 16]            # 16 段階のうち 6 段階を使う
CENTER = [14, 40, 53, 76, 100, 124]       # その録音が担当する強さの中心（元の SFZ の範囲から）
HEADROOM = -6.0                           # ならしたときに割れないよう、ファイルは 6 dB 下げておく（再生側で戻す）
FLOOR_DB = -66.0                          # ここより小さくなったら切る（dBFS）
FADE = 1.2                                # 最後のフェードの長さ（秒）


def fname(name):
    return name.replace('#', 's')


def max_len(midi):
    # 高さごとの最大の長さ（秒）。低い音ほど長く鳴る
    if midi < 36:
        return 11.0
    if midi < 60:
        return 10.0
    if midi < 76:
        return 8.0
    if midi < 88:
        return 6.0
    return 4.5


def onset_of(x, sr):
    m = np.abs(x).max(axis=1)
    pk = m[: sr].max()
    return max(0, int(np.argmax(m > pk * 0.02)) - int(sr * 0.0005))


def read(path):
    x, sr = sf.read(path, dtype='float64', always_2d=True)
    return x, sr


def env_db(x, sr, win=0.05):
    n = int(sr * win)
    m = np.abs(x).max(axis=1)
    c = len(m) // n
    return 20 * np.log10(np.sqrt(np.mean(m[: c * n].reshape(-1, n) ** 2, axis=1)) + 1e-9), n


def encode(x, sr, path, q):
    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, 'a.wav')
        sf.write(wav, x, sr, subtype='PCM_24')
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-threads', '1', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', str(q), '-map_metadata', '-1', '-id3v2_version', '0', path], check=True)


os.makedirs(OUT, exist_ok=True)

# ① 全部の音量を測る
print('measuring...')
level = np.zeros((len(NAMES), len(LAYERS)))
for i, name in enumerate(NAMES):
    for j, v in enumerate(LAYERS):
        x, sr = read(os.path.join(SRC, f'{name}v{v}.flac'))
        o = onset_of(x, sr)
        seg = x[o: o + int(sr * 0.25)]
        level[i, j] = 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9)

# ② 高さ方向になめらかな「あるべき音量」を作る（前後の音との中央値 → 移動平均）
smooth = np.zeros_like(level)
for j in range(len(LAYERS)):
    col = level[:, j]
    med = np.array([np.median(col[max(0, i - 3): i + 4]) for i in range(len(col))])
    smooth[:, j] = np.array([np.mean(med[max(0, i - 2): i + 3]) for i in range(len(col))])
# 強さの順に音量が必ず上がるように（まれに逆転するところを直す）
for i in range(len(NAMES)):
    for j in range(1, len(LAYERS)):
        smooth[i, j] = max(smooth[i, j], smooth[i, j - 1] + 0.5)
adjust = smooth - level
print('adjust dB range', round(float(adjust.min()), 1), round(float(adjust.max()), 1))

# ③ 書き出す
total = 0
lengths = []
for i, name in enumerate(NAMES):
    for j, v in enumerate(LAYERS):
        x, sr = read(os.path.join(SRC, f'{name}v{v}.flac'))
        o = onset_of(x, sr)
        x = x[o:] * 10 ** ((adjust[i, j] + HEADROOM) / 20)
        e, n = env_db(x, sr)
        above = np.where(e > FLOOR_DB)[0]
        end = (above[-1] + 1) * n if len(above) else len(x)
        dur = min(end / sr, max_len(MIDI[i]))
        keep = min(len(x), int(sr * dur))
        x = x[: keep].copy()
        fade = min(int(sr * FADE), keep // 2)
        x[keep - fade:] *= np.cos(np.linspace(0, np.pi / 2, fade))[:, None] ** 2
        x[: 24] *= np.linspace(0, 1, 24)[:, None]
        pk = np.abs(x).max()
        if pk > 0.97:
            raise SystemExit(f'too loud {name}v{v}: {pk}')
        p = os.path.join(OUT, f'{fname(name)}v{v}.mp3')
        encode(x, sr, p, 4)
        total += os.path.getsize(p)
        lengths.append(keep / sr)
    print(name, f'{total / 1e6:.1f} MB', flush=True)

# 指を離したときの音（ダンパーと鍵盤の音）。高さごとに 1 つ（30 点）
for i, m in enumerate(MIDI):
    x, sr = read(os.path.join(SRC, f'rel{m - 20}.flac'))
    fade = int(sr * 0.1)
    x = x.copy()
    x[len(x) - fade:] *= np.linspace(1, 0, fade)[:, None]
    p = os.path.join(OUT, f'rel{fname(NAMES[i])}.mp3')
    encode(x, sr, p, 6)
    total += os.path.getsize(p)

# ペダルを踏む音・離す音（踏む音は 2 秒で切る）
for name, cut in (('pedalD1', 2.0), ('pedalD2', 2.0), ('pedalU1', 0.7), ('pedalU2', 0.7)):
    x, sr = read(os.path.join(SRC, name + '.flac'))
    x = x[: int(sr * cut)].copy()
    fade = int(sr * 0.3)
    x[len(x) - fade:] *= np.linspace(1, 0, fade)[:, None] ** 2
    p = os.path.join(OUT, name + '.mp3')
    encode(x, sr, p, 6)
    total += os.path.getsize(p)

# ④ 再生側で使う表：強さごとの音量（中音域の平均）
mid = [i for i, m in enumerate(MIDI) if 36 <= m <= 84]
layer_db = [round(float(np.mean(smooth[mid, j])), 2) for j in range(len(LAYERS))]
names_js = [fname(n) for n in NAMES]
js = (
    '// tools/build_piano.py が作るファイル（手で直さない）\n'
    f'export const PIANO = {json.dumps({"names": names_js, "midi": MIDI, "layers": LAYERS, "center": CENTER, "layerDb": layer_db, "headroom": HEADROOM}, ensure_ascii=False)};\n'
)
with open(DATA, 'w', encoding='utf-8', newline='\n') as f:
    f.write(js)
print(f'done: {total / 1e6:.1f} MB, {len(lengths)} notes, avg {np.mean(lengths):.1f}s, sum {np.sum(lengths):.0f}s, decoded(48k stereo float) {np.sum(lengths) * 48000 * 8 / 1e6:.0f} MB')
print('layerDb', layer_db)
