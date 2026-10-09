import os, base64, zlib, struct
from dotenv import load_dotenv
from openai import OpenAI
load_dotenv("../.env")
c = OpenAI(base_url=os.getenv("NEBIUS_BASE_URL"), api_key=os.getenv("NEBIUS_API_KEY"), timeout=40)
def png(w=64, h=64):
    raw = b"".join(b"\x00" + bytes([128, 128, 128]) * w for _ in range(h))
    def ch(t, d):
        x = struct.pack(">I", len(d)) + t + d
        return x + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")
img = "data:image/png;base64," + base64.b64encode(png()).decode()
skip = ("embed", "bge", "rerank", "guard", "safety", "flux", "whisper", "stable", "sdxl", "parse")
for m in c.models.list():
    if any(k in m.id.lower() for k in skip): continue
    try:
        c.chat.completions.create(model=m.id, max_tokens=5, messages=[{"role": "user", "content": [{"type": "text", "text": "hi"}, {"type": "image_url", "image_url": {"url": img}}]}])
        print("IMAGE OK ", m.id)
    except Exception as e:
        print("no       ", m.id, "-", str(e)[:50].replace("\n", " "))
