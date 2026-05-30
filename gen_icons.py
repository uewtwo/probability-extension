#!/usr/bin/env python3
"""probability 拡張のアイコンを生成する。確率分布(ガウス曲線)をモチーフにしたダークなアイコン。"""
import struct, zlib, math, os

ACCENT = (139, 92, 246)   # 紫 (indigo-violet)
ACCENT2 = (99, 102, 241)  # 青紫
BG = (15, 17, 23)         # ダーク背景


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_icon(size):
    px = [[BG[:] for _ in range(size)] for _ in range(size)]
    r = size * 0.22  # 角丸半径

    def in_rounded(x, y):
        # 角丸矩形の内側判定（少し余白）
        m = size * 0.06
        x0, y0, x1, y1 = m, m, size - m, size - m
        if x < x0 or x > x1 or y < y0 or y > y1:
            return False
        cx = min(max(x, x0 + r), x1 - r)
        cy = min(max(y, y0 + r), y1 - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2

    # ガウス曲線パラメータ
    sigma = size * 0.16
    mu = size * 0.5
    peak_y = size * 0.30      # 曲線頂点の y
    base_y = size * 0.74      # 裾の y
    amp = base_y - peak_y
    line_w = max(1.4, size * 0.05)

    for y in range(size):
        for x in range(size):
            if not in_rounded(x + 0.5, y + 0.5):
                continue
            # 背景: 縦方向グラデーション（わずかに明るく）
            t = y / size
            base = lerp((22, 24, 33), (15, 17, 23), t)
            px[y][x] = list(base)

    # ガウス曲線を描画（アンチエイリアス風）
    for x in range(size):
        gx = (x - mu)
        gauss = math.exp(-(gx ** 2) / (2 * sigma ** 2))
        curve_y = base_y - amp * gauss
        for y in range(size):
            if not in_rounded(x + 0.5, y + 0.5):
                continue
            d = abs(y - curve_y)
            if d <= line_w:
                a = max(0.0, 1.0 - (d / line_w))
                col = lerp(ACCENT2, ACCENT, x / size)
                px[y][x] = list(lerp(tuple(px[y][x]), col, a))
            # 曲線下の塗り（薄く）
            elif y > curve_y and y < base_y:
                col = lerp(ACCENT2, ACCENT, x / size)
                px[y][x] = list(lerp(tuple(px[y][x]), col, 0.10))

    # ベースライン
    by = int(base_y)
    for x in range(size):
        for yy in (by, by + 1):
            if 0 <= yy < size and in_rounded(x + 0.5, yy + 0.5):
                px[yy][x] = list(lerp(tuple(px[yy][x]), (120, 120, 140), 0.5))

    # RGBA バイト列に
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0
        for x in range(size):
            r_, g_, b_ = px[y][x]
            alpha = 255 if in_rounded(x + 0.5, y + 0.5) else 0
            raw += bytes((r_, g_, b_, alpha))
    return bytes(raw)


def write_png(path, size):
    raw = make_icon(size)

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        c += struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        return c

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))
    print("wrote", path, size)


for s in (16, 32, 48, 128):
    write_png(os.path.join("icons", f"icon{s}.png"), s)
