"""Convert a generated MPEG-4/AAC MKV fixture to its legacy VFW/XVID layout.

Usage: python make-vfw-mpeg4-fixture.py input.mkv output.mkv
Generate input with FFmpeg testsrc2 + sine, MPEG-4 video/AAC audio, 12 seconds,
160x96/25 fps, GOP 25, and -write_crc32 0. No third-party media is included.
Rebuild both SeekHead and Cues because changing CodecPrivate changes offsets.
"""
import pathlib, struct, sys

def vint(value):
    for width in range(1, 9):
        if value < (1 << (7 * width)) - 1:
            return ((1 << (7 * width)) | value).to_bytes(width, 'big')
    raise ValueError('oversized element')

def el(identifier, data):
    return identifier.to_bytes((identifier.bit_length()+7)//8, 'big')+vint(len(data))+data

def uint(identifier, value):
    return el(identifier, value.to_bytes(8, 'big'))

def elements(data):
    cursor = 0
    while cursor < len(data):
        start = cursor
        def field(is_size):
            nonlocal cursor
            first = data[cursor]
            width = next(w for w in range(1, 9) if first & (256 >> w))
            value = int.from_bytes(data[cursor:cursor+width], 'big')
            cursor += width
            return value & ((1 << (7 * width))-1) if is_size else value
        identifier, size = field(False), field(True)
        body = data[cursor:cursor+size]
        if len(body) != size: raise ValueError('truncated generated fixture')
        cursor += size
        yield identifier, body, data[start:cursor]

source = pathlib.Path(sys.argv[1]).read_bytes()
top = list(elements(source))
header = next(raw for identifier, body, raw in top if identifier == 0x1a45dfa3)
segment = next(body for identifier, body, raw in top if identifier == 0x18538067)
fields = list(elements(segment))
info = next(raw for identifier, body, raw in fields if identifier == 0x1549a966)
track_body = next(body for identifier, body, raw in fields if identifier == 0x1654ae6b)
tracks = []
video_number = None
for identifier, body, raw in elements(track_body):
    if identifier != 0xae:
        tracks.append(raw); continue
    entry = list(elements(body))
    kind = next(int.from_bytes(b,'big') for i,b,r in entry if i == 0x83)
    if kind != 1:
        tracks.append(raw); continue
    video_number = next(int.from_bytes(b,'big') for i,b,r in entry if i == 0xd7)
    assert next(b for i,b,r in entry if i == 0x86) == b'V_MPEG4/ISO/ASP'
    private = next((b for i,b,r in entry if i == 0x63a2), b'')
    bitmap = struct.pack('<IiiHH4sIiiII',40,160,96,1,24,b'XVID',0,0,0,0,0)
    rewritten = [el(0x86,b'V_MS/VFW/FOURCC') if i==0x86 else r for i,b,r in entry if i != 0x63a2]
    rewritten.append(el(0x63a2,bitmap+private))
    tracks.append(el(0xae,b''.join(rewritten)))
assert video_number is not None
tracks = el(0x1654ae6b,b''.join(tracks))
clusters = [(body,raw) for identifier,body,raw in fields if identifier == 0x1f43b675]
def seek_head(position):
    return el(0x114d9b74,el(0x4dbb,el(0x53ab,bytes.fromhex('1c53bb6b'))+uint(0x53ac,position)))
offset = len(info)+len(tracks)+len(seek_head(0))
cues = []
for body, raw in clusters:
    time = next(int.from_bytes(b,'big') for i,b,r in elements(body) if i == 0xe7)
    cues.append(el(0xbb,uint(0xb3,time)+el(0xb7,uint(0xf7,video_number)+uint(0xf1,offset))))
    offset += len(raw)
body = info+tracks+seek_head(offset)+b''.join(raw for _,raw in clusters)+el(0x1c53bb6b,b''.join(cues))
pathlib.Path(sys.argv[2]).write_bytes(header+el(0x18538067,body))
