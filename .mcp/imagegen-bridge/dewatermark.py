#!/usr/bin/env python3
# 去除图片右下角固定位置的水印（imagegen 服务叠加的半透明文字水印）
# 水印为右下角固定矩形区域内的文字（约 62-80px 宽、24-25px 高，贴近右下边角）
# 策略：对右下角完整矩形区域做 inpaint，从周围内容重建
# stdin 传 base64（可带 dataURL 前缀），stdout 输出去水印后的 base64（dataURL）
# 环境缺依赖或解码失败时，stdout 输出空串表示原样返回
import sys, base64

def main():
    data = sys.stdin.read().strip()
    if not data:
        return
    try:
        import cv2
        import numpy as np
    except Exception:
        return
    if data.startswith("data:") and "," in data:
        data = data.split(",", 1)[1]
    try:
        raw = base64.b64decode(data)
    except Exception:
        return
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return
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
    ok, buf = cv2.imencode(".png", res)
    if not ok:
        return
    sys.stdout.write("data:image/png;base64," + base64.b64encode(buf.tobytes()).decode())

if __name__ == "__main__":
    main()
