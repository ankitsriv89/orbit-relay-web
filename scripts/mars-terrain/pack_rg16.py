#!/usr/bin/env python3
"""pack_rg16.py — 16-bit grayscale PNG -> RG-packed 8-bit RGB PNG.

R = high byte, G = low byte, B = 0. The game (terrain.js) decodes
(R*256 + G) / 65535 in both the vertex shader and the CPU sampler —
a decode that is exactly backward-compatible with plain 8-bit
grayscale maps (R=G=v gives v*257/65535 = v/255).

Canvas getImageData() is locked to 8 bits per channel, so a real
16-bit PNG can't be read directly in the browser; two 8-bit channels
can. Called by prep_site.sh; needs numpy + Pillow (.venv has both).
"""
import sys

import numpy as np
from PIL import Image

if len(sys.argv) != 3:
    sys.exit('usage: pack_rg16.py <in_16bit_gray.png> <out_rg_rgb.png>')

src, dst = sys.argv[1], sys.argv[2]
a = np.asarray(Image.open(src))
if a.ndim != 2:
    sys.exit(f'FATAL: expected single-band input, got shape {a.shape}')
if a.min() < 0 or a.max() > 65535:
    sys.exit(f'FATAL: values outside uint16 range ({a.min()}..{a.max()})')
a = a.astype(np.uint16)  # PIL may hand back int32 for mode "I"

rgb = np.zeros((*a.shape, 3), dtype=np.uint8)
rgb[..., 0] = a >> 8
rgb[..., 1] = a & 0xFF
Image.fromarray(rgb).save(dst, optimize=True)
print(f'  packed {a.shape[1]}x{a.shape[0]} 16-bit -> RG PNG: {dst}')
