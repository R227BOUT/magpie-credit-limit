#!/usr/bin/env python3
"""画 magpie-plugin-credit-limit 的图标：三条额度槽 + 一道闸门。

纯几何绘制，不用任何外部素材，也不用生成式模型。改配色改这里重跑即可：

    python tools/make-icon.py

产出 ../icon.png（256x256，同时把 base64 写回 package.json 的
magpie.icon —— 商店卡只看那一个字段）。
"""
from PIL import Image, ImageDraw
import base64
import json
import os

# ── 配色：取自面板 CSS 的青竹系 ──────────────────────────────────────
BG = (66, 112, 97, 255)        # #427061 深竹，面板的 --magpie-accent
SLOT = (38, 66, 57, 255)       # #264239 槽底，比底色更深，让「空」看得见
FILL = (238, 241, 235, 255)    # #EEF1EB 已用额度，米白
GATE = (164, 66, 60, 255)      # #a4423c 闸门，面板的 .err 色

SIZE = 256
SS = 4                          # 超采样倍数，缩回 256 时边缘才干净

# 三条槽的填充比例：0.78 / 0.48 / 0.26 —— 递减，一眼看出「越用越少」
LEVELS = (0.78, 0.48, 0.26)


def build() -> Image.Image:
    w = SIZE * SS
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def rr(x0, y0, x1, y1, r, fill):
        d.rounded_rectangle(
            [x0 * SS, y0 * SS, x1 * SS, y1 * SS], radius=r * SS, fill=fill
        )

    # 底板：圆角方，四周留 6px 透明边（magpie 卡片自己有圆角和边框）
    rr(6, 6, SIZE - 6, SIZE - 6, 60, BG)

    bar_w, gap = 36, 24
    x0 = (SIZE - (bar_w * 3 + gap * 2)) // 2
    top, base = 58, 198

    for i, h in enumerate(LEVELS):
        x = x0 + i * (bar_w + gap)
        rr(x, top, x + bar_w, base, bar_w / 2, SLOT)          # 空槽
        fh = int((base - top) * h)
        rr(x, base - fh, x + bar_w, base, bar_w / 2, FILL)    # 已用部分

    # 第三档上方压一道闸门：额度到头就停
    cx = x0 + 2 * (bar_w + gap) + bar_w / 2
    rr(cx - 26, 116, cx + 26, 130, 7, GATE)

    return img.resize((SIZE, SIZE), Image.LANCZOS)


def embed(icon_path: str, pkg_path: str) -> int:
    """把图标 base64 写进 package.json 的 magpie.icon，返回字符数。"""
    png = open(icon_path, "rb").read()
    uri = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    if len(uri) > 3 << 19:
        raise SystemExit(f"magpie.icon 超长：{len(uri)} > {3 << 19}")

    pkg = json.load(open(pkg_path, encoding="utf-8"))
    mg = {"icon": uri}
    for k, v in (pkg.get("magpie") or {}).items():
        if k != "icon":
            mg[k] = v
    pkg["magpie"] = mg
    tmp = pkg_path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, pkg_path)
    return len(uri)


if __name__ == "__main__":
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icon = os.path.join(root, "icon.png")
    pkg = os.path.join(root, "package.json")

    build().save(icon, "PNG", optimize=True)
    print(f"写入 {icon}（{os.path.getsize(icon)} bytes）")
    n = embed(icon, pkg)
    print(f"已内嵌到 package.json 的 magpie.icon（{n} 字符）")
