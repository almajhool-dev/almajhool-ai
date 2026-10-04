# تجربة: Pollinations gptimage يعدّل نفس الصورة فعلًا؟ (نقارن بمصادر ترسم من جديد)
import os, time, urllib.request, urllib.parse
IMG_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/500px-Cat03.jpg"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
def get(url, timeout=120):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.status, r.headers.get("content-type", ""), r.read()
os.makedirs("probe_out", exist_ok=True)
open("probe_out/0-source.jpg", "wb").write(get(IMG_URL)[2])
edits = {"blue-bg": "Change only the background to bright blue. Keep the cat exactly the same.",
         "remove-ears": "اشيل الخلفية وخليها بيضة، وخلي القطة نفسها بدون تغيير"}
for model in ["gptimage", "flux"]:
    for name, edit in edits.items():
        t = time.time()
        url = f"https://image.pollinations.ai/prompt/{urllib.parse.quote(edit)}?model={model}&image={urllib.parse.quote(IMG_URL, safe='')}&nologo=true&referrer=almajhool-ai.vercel.app"
        try:
            st, ct, data = get(url)
            open(f"probe_out/{model}-{name}.jpg", "wb").write(data)
            print("POLLINATIONS", model, name, st, ct, len(data), f"{time.time()-t:.1f}s")
        except Exception as e:
            print("POLLINATIONS", model, name, "ERR", str(e)[:200])
