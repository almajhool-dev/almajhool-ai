# تجربة: منو يگدر يعدل صورة مجانًا؟ (Gemini بمفتاحنا، Pollinations kontext، مساحات Hugging Face)
import base64, json, os, time, urllib.request, urllib.parse
IMG_URL = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/500px-Cat03.jpg"
EDIT = "Remove the cat's whiskers and make the background bright blue. Keep everything else the same."
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}

def get(url, headers=None, timeout=90):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.headers.get("content-type", ""), r.read()

st, ct, img = get(IMG_URL)
print("SOURCE", st, ct, len(img))
os.makedirs("probe_out", exist_ok=True)
open("probe_out/source.jpg", "wb").write(img)
key = os.environ.get("GEMINI_API_KEY", "")

for model in ["gemini-2.5-flash-image", "gemini-3.1-flash-image", "gemini-3.1-flash-image-preview", "gemini-3-pro-image",
              "gemini-3-pro-image-preview", "nano-banana-pro-preview", "gemini-3.1-flash-lite-image", "gemini-omni-flash-preview", "gemini-omni-1.1-flash"]:
    t = time.time()
    body = json.dumps({"contents": [{"role": "user", "parts": [{"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(img).decode()}}, {"text": EDIT}]}],
                       "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]}}).encode()
    req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", data=body,
                                 headers={"x-goog-api-key": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.load(r)
        parts = d.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        im = next((p.get("inlineData") or p.get("inline_data") for p in parts if p.get("inlineData") or p.get("inline_data")), None)
        if im:
            open(f"probe_out/{model}.png", "wb").write(base64.b64decode(im["data"]))
        print("GEMINI", model, "OK image" if im else "NO image", f"{time.time()-t:.1f}s", [p.get("text", "")[:80] for p in parts if p.get("text")])
    except urllib.error.HTTPError as e:
        print("GEMINI", model, e.code, e.read()[:200].decode(errors="replace").replace("\n", " "))
    except Exception as e:
        print("GEMINI", model, "ERR", e)

for model in ["kontext", "gptimage", "nanobanana", "seedream"]:
    t = time.time()
    url = f"https://image.pollinations.ai/prompt/{urllib.parse.quote(EDIT)}?model={model}&image={urllib.parse.quote(IMG_URL, safe='')}&nologo=true&referrer=almajhool-ai.vercel.app"
    try:
        st, ct, data = get(url, timeout=120)
        if ct.startswith("image/"):
            open(f"probe_out/pollinations-{model}.jpg", "wb").write(data)
        print("POLLINATIONS", model, st, ct, len(data), f"{time.time()-t:.1f}s")
    except urllib.error.HTTPError as e:
        print("POLLINATIONS", model, e.code, e.read()[:200].decode(errors="replace").replace("\n", " "))
    except Exception as e:
        print("POLLINATIONS", model, "ERR", e)

try:
    from gradio_client import Client, handle_file
    for space in ["black-forest-labs/FLUX.1-Kontext-Dev", "Qwen/Qwen-Image-Edit", "multimodalart/Qwen-Image-Edit-Fast", "InstantX/Qwen-Image-Edit", "akhaliq/Qwen-Image-Edit-2509"]:
        t = time.time()
        try:
            c = Client(space, verbose=False)
            api = c.view_api(return_format="dict", print_info=False)
            names = list(api.get("named_endpoints", {}).keys())
            print("SPACE", space, "endpoints", names[:6])
            ep = names[0]
            params = api["named_endpoints"][ep]["parameters"]
            args = []
            for p in params:
                pn = p.get("parameter_name") or p.get("label", "")
                comp = str(p.get("component", "")).lower()
                if comp in ("image", "imageeditor", "gallery") or "image" in pn.lower() and comp != "textbox":
                    args.append(handle_file(IMG_URL) if comp != "gallery" else [handle_file(IMG_URL)])
                elif comp == "textbox" or "prompt" in pn.lower():
                    args.append(EDIT)
                else:
                    args.append(p.get("parameter_default"))
            res = c.predict(*args, api_name=ep)
            print("SPACE", space, "RESULT", str(res)[:200], f"{time.time()-t:.1f}s")
        except Exception as e:
            print("SPACE", space, "ERR", str(e)[:200])
except Exception as e:
    print("GRADIO_CLIENT_ERR", e)
