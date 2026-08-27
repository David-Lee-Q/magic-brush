#!/usr/bin/env python3
# 下载专用处理：去除右下角显式标识（水印）+ 写入隐式元数据（PNG tEXt）
# 水印为右下角固定矩形区域内的文字（imagegen 服务叠加，贴近右下边角）
# stdin 传 base64（可带 dataURL 前缀）
# 参数 --meta '<json>'：要写入的隐式元数据键值对
# stdout 第一行 "宽x高"，第二行输出处理后的 PNG base64（无前缀）
import sys, json, base64, io, argparse

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--meta", default="{}")
    args = parser.parse_args()

    data = sys.stdin.read().strip()
    if not data:
        sys.exit("空输入")
    try:
        meta = json.loads(args.meta or "{}")
    except Exception:
        meta = {}
    if data.startswith("data:") and "," in data:
        data = data.split(",", 1)[1]
    try:
        import cv2
        import numpy as np
    except Exception as e:
        sys.exit("缺少依赖 cv2/numpy: " + str(e))
    try:
        from PIL import Image, PngImagePlugin
    except Exception as e:
        sys.exit("缺少依赖 PIL: " + str(e))

    try:
        raw = base64.b64decode(data)
    except Exception as e:
        sys.exit("base64 解码失败: " + str(e))
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        sys.exit("图片解码失败")
    h, w = img.shape[:2]
    mr = max(2, int(round(w * 0.002)))
    mb = max(2, int(round(h * 0.002)))
    bw = max(80, int(round(w * 0.095)))
    bh = max(34, int(round(h * 0.034)))
    x0 = w - mr - bw
    y0 = h - mb - bh
    x1 = w - mr
    y1 = h - mb
    mask = np.zeros((h, w), np.uint8)
    mask[y0:y1, x0:x1] = 255
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8))
    res = cv2.inpaint(img, mask, 6, cv2.INPAINT_TELEA)
    rgb = cv2.cvtColor(res, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    pnginfo = PngImagePlugin.PngInfo()
    for k, v in meta.items():
        if v is not None:
            pnginfo.add_text(str(k), str(v))
    buf = io.BytesIO()
    pil.save(buf, "PNG", pnginfo=pnginfo)
    sys.stdout.write(str(w) + "x" + str(h) + "\n")
    sys.stdout.write(base64.b64encode(buf.getvalue()).decode())
    sys.stdout.flush()

if __name__ == "__main__":
    main()
