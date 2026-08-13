#!/usr/bin/env python3
"""用 OpenCV QRCodeDetector 解码配对 QR PNG，stdout 打印载荷。"""
from __future__ import annotations

import sys

import cv2


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: decode-pairing-qr.py <png>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        print(f"decode_failed: cannot read {path}", file=sys.stderr)
        return 1
    detector = cv2.QRCodeDetector()
    value, points, _ = detector.detectAndDecode(img)
    if not value:
        print("decode_failed: empty", file=sys.stderr)
        return 1
    print(value)
    if points is not None:
        print(f"# points={points.shape}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
