#!/usr/bin/env python3
"""Make the two World board tiles from two ready-made images (instead of drawing them from the database).

  python make_static_board.py <left image> <right image> <output folder>

Each image is scaled to 2048 px wide and centred on a white 2048 x 1638 tile (the board is 5:2 = two 5:4 tiles side by side),
saved as <output>/tile-1.jpg (left) and tile-2.jpg (right). To make the automatic publisher keep these images, put an empty
file named  board/.static  next to them (see .github/workflows/publish.yml). Delete that file to draw the board from data again.
"""
import sys
from pathlib import Path
from PIL import Image

W, H = 2048, 1638


def tile(path):
    im = Image.open(path)
    if im.mode in ('RGBA', 'LA', 'P'):           # transparent areas become white, not black
        rgba = im.convert('RGBA'); flat = Image.new('RGB', rgba.size, (255, 255, 255)); flat.paste(rgba, mask=rgba.split()[3]); im = flat
    else:
        im = im.convert('RGB')
    c = Image.new('RGB', (W, H), (255, 255, 255))
    h = round(im.height * W / im.width)
    if h > H:                                   # taller than 5:4: fit by height instead
        w = round(im.width * H / im.height); r = im.resize((w, H), Image.LANCZOS); c.paste(r, ((W - w) // 2, 0))
    else:
        r = im.resize((W, h), Image.LANCZOS); c.paste(r, (0, (H - h) // 2))
    return c


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    out = Path(sys.argv[3]); out.mkdir(parents=True, exist_ok=True)
    for name, src in (('tile-1.jpg', sys.argv[1]), ('tile-2.jpg', sys.argv[2])):
        tile(src).save(out / name, quality=90, optimize=True, subsampling=0)
        print('wrote', out / name)
