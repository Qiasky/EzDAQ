"""Generate native tab bar PNGs from geometric strokes, no image dependency."""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'miniprogram' / 'assets'
ROOT.mkdir(exist_ok=True)

def icon(name, color):
    size, scale = 48, 3
    samples = [[False] * (size * scale) for _ in range(size * scale)]
    def line(a, b, thickness=2):
        ax, ay = a; bx, by = b
        length = (bx-ax)**2 + (by-ay)**2
        for y in range(size * scale):
            for x in range(size * scale):
                px, py = (x+.5)/scale, (y+.5)/scale
                t = max(0, min(1, ((px-ax)*(bx-ax)+(py-ay)*(by-ay))/length)) if length else 0
                if (px-ax-t*(bx-ax))**2 + (py-ay-t*(by-ay))**2 <= (thickness/2)**2:
                    samples[y][x] = True
    def path(points):
        for a, b in zip(points, points[1:]): line(a, b)
    def circle(cx, cy, r):
        points = [(cx+math.cos(t*math.pi/32)*r, cy+math.sin(t*math.pi/32)*r) for t in range(65)]
        path(points)
    if name == 'overview':
        for x, y in [(10,10),(27,10),(10,27),(27,27)]: path([(x,y),(x+11,y),(x+11,y+11),(x,y+11),(x,y)])
    elif name == 'alarm':
        path([(12,33),(15,29),(15,21),(17,15),(21,12),(27,12),(31,15),(33,21),(33,29),(36,33),(12,33)])
        path([(21,38),(27,38)]); line((24,8),(24,11))
    else:
        circle(24,18,7)
        path([(11,39),(12,33),(16,29),(21,27),(27,27),(32,29),(36,33),(37,39)])
    data = bytearray()
    for y in range(size):
        data.append(0)
        for x in range(size):
            count = sum(samples[yy][xx] for yy in range(y*scale,(y+1)*scale) for xx in range(x*scale,(x+1)*scale))
            data.extend((*color, round(count / (scale*scale) * 255)))
    def chunk(kind, payload): return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind+payload))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0)) + chunk(b'IDAT', zlib.compress(bytes(data))) + chunk(b'IEND',b'')

for name in ['overview', 'alarm', 'mine']:
    for suffix, color in [('',(135,147,158)),('-active',(20,125,114))]:
        (ROOT / f'{name}{suffix}.png').write_bytes(icon(name,color))
print('6 tab bar icons generated')
