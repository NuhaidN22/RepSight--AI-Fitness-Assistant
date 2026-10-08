import os
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv("../.env")
c = OpenAI(base_url=os.getenv("NEBIUS_BASE_URL"), api_key=os.getenv("NEBIUS_API_KEY"), timeout=90)

models = [
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/nemotron-nano-3-30b-a3b",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-4-340b-instruct",
]
for m in models:
    try:
        r = c.chat.completions.create(model=m, messages=[{"role": "user", "content": "Say hi"}], max_tokens=30)
        print("OK  ", m, "->", (r.choices[0].message.content or "")[:40])
    except Exception as e:
        print("FAIL", m, "->", str(e)[:70])