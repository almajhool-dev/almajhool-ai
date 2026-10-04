#!/usr/bin/env python3
"""رفع دقة المقاطع بالذكاء الاصطناعي على أجهزة GitHub المجانية (Real-ESRGAN realesr-general-x4v3).

المراحل (كل وحدة بخطوة من .github/workflows/upscale.yml):
  prepare  ← ياخذ المقطع من الطابور، ينزله من تلكرام، يوحّد الإطارات، ويقسمه على عدة أجهزة
  process  ← كل جهاز يرفع دقة جزئه إطار إطار
  merge    ← يجمع الأجزاء ويرجع الصوت الأصلي ويدز المقطع للمستخدم
  test     ← تجربة كاملة على مقطع تجريبي بدون تلكرام

الحجم: مع TELEGRAM_API_ID/TELEGRAM_API_HASH يستلم ويدز لحد 2GB، وبدونهم حدود بوت تلكرام (20MB استلام، 50MB إرسال).
"""
import asyncio, glob, hashlib, json, math, os, shutil, subprocess, sys, time, urllib.request

BOT = os.environ.get("TELEGRAM_BOT_TOKEN", "")
SITE = os.environ.get("SITE_URL", "https://almajhool-ai.vercel.app").rstrip("/")
API_ID = os.environ.get("TELEGRAM_API_ID", "")
API_HASH = os.environ.get("TELEGRAM_API_HASH", "")
MTPROTO = bool(API_ID and API_HASH and BOT)
WORK = os.path.abspath(os.environ.get("WORK_DIR", "work"))
MODEL_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth"
SEC_PER_FRAME_360P = 3.6     # قياس فعلي على جهاز GitHub (4 أنوية) لنموذج x4 على 640×360
PIXELS_360P = 640 * 360
MAX_WORKERS = 20             # أقصى عدد أجهزة GitHub بنفس الوقت (مستودع عام)
WORKER_BUDGET = 4.5 * 3600   # وقت المعالجة لكل جهاز (حد GitHub 6 ساعات)
TARGET_PER_WORKER = 180      # نحاول كل جهاز يخلص جزئه بحدود 3 دقايق
BOTAPI_IN, BOTAPI_OUT = 20 * 1024 * 1024, 49 * 1024 * 1024
# ترميز يشتغل سلس على الموبايل: High profile، حد أعلى للبت ريت (بدون قفزات تخلي التشغيل يتقطع)
PLAYABLE = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-maxrate", "8M", "-bufsize", "8M", "-pix_fmt", "yuv420p"]


def log(*a):
    print(*a, flush=True)


def sh(cmd, **kw):
    log("$", " ".join(cmd) if isinstance(cmd, list) else cmd)
    return subprocess.run(cmd, check=True, **kw)


def download(url, path):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36"})
    with urllib.request.urlopen(req, timeout=600) as r, open(path, "wb") as f:
        shutil.copyfileobj(r, f, 1024 * 1024)


def even(x):
    return max(2, int(round(x / 2)) * 2)


# ───────── تلكرام (Bot API) ─────────
def bot_api(method, data=None, files=None, timeout=60):
    url = f"https://api.telegram.org/bot{BOT}/{method}"
    if files:
        boundary = "----almajhool" + hashlib.md5(str(time.time()).encode()).hexdigest()
        body = b""
        for k, v in (data or {}).items():
            body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        for k, (name, path, mime) in files.items():
            with open(path, "rb") as f:
                body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + f.read() + b"\r\n"
        body += f"--{boundary}--\r\n".encode()
        req = urllib.request.Request(url, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    else:
        req = urllib.request.Request(url, data=json.dumps(data or {}).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        log("telegram error", method, e)
        return {"ok": False}


def say(job, text):
    """يحدّث رسالة الحالة عند المستخدم (أو يدز رسالة جديدة)"""
    if not BOT or not job or job.get("test"):
        log("STATUS:", text)
        return
    if job.get("status_message_id"):
        r = bot_api("editMessageText", {"chat_id": job["chat_id"], "message_id": job["status_message_id"], "text": text})
        if r.get("ok"):
            return
    bot_api("sendMessage", {"chat_id": job["chat_id"], "text": text})


def site(action, **payload):
    key = hashlib.sha256(f"{BOT}:video-worker".encode()).hexdigest()[:48]
    req = urllib.request.Request(f"{SITE}/api/video-jobs", data=json.dumps({"action": action, **payload}).encode(),
                                 headers={"Content-Type": "application/json", "x-worker-key": key, "User-Agent": "almajhool-worker"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


# ───────── MTProto (لحد 2GB) ─────────
async def _mt(fn):
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    client = TelegramClient(StringSession(), int(API_ID), API_HASH)
    await client.start(bot_token=BOT)
    try:
        return await fn(client)
    finally:
        await client.disconnect()


def mt_download(job, path):
    async def run(client):
        m = await client.get_messages(None, ids=int(job["message_id"]))
        if not m or not m.media:
            raise RuntimeError("ما لگيت المقطع بالمحادثة")
        await client.download_media(m, file=path)
    asyncio.run(_mt(run))


def mt_send(job, path, caption, w, h, duration):
    async def run(client):
        from telethon.tl.types import DocumentAttributeVideo
        m = await client.get_messages(None, ids=int(job["message_id"]))
        attrs = [DocumentAttributeVideo(duration=int(duration), w=w, h=h, supports_streaming=True)]
        if m:
            await m.reply(caption, file=path, attributes=attrs, supports_streaming=True)
        else:
            await client.send_file(int(job["chat_id"]), path, caption=caption, attributes=attrs, supports_streaming=True)
    asyncio.run(_mt(run))


# ───────── أدوات الفيديو ─────────
def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "stream=index,codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames:stream_tags=rotate:format=duration",
                          "-of", "json", path], capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    v = next(s for s in d["streams"] if s["codec_type"] == "video")
    has_audio = any(s["codec_type"] == "audio" for s in d["streams"])
    num, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 30.0
    if not (1 <= fps <= 120):
        fps = 30.0
    dur = float(d.get("format", {}).get("duration") or 0)
    return {"w": int(v["width"]), "h": int(v["height"]), "fps": fps, "duration": dur, "audio": has_audio,
            "frames": int(v.get("nb_frames") or 0) or int(round(dur * fps))}


def plan_for(info):
    """يقرر حجم دخول النموذج وحجم الناتج وعدد الأجهزة حسب الدقة والطول"""
    w, h, n = info["w"], info["h"], info["frames"]
    long = max(w, h)
    mode = "ai"
    s = 1.0 if long <= 960 else 960 / long          # النموذج يشتغل على ≤960 بكسل (الأوضح والأسرع)
    if long > 1920:
        mode = "ffmpeg"                              # المقطع أصلًا عالي الدقة: تحسين وتوضيح بدون تكبير
    mw, mh = even(w * s), even(h * s)
    per_frame = SEC_PER_FRAME_360P * (mw * mh) / PIXELS_360P * 1.15
    # نوزع حسب الوقت المتوقع: كل جهاز ياخذ تقريبًا 3 دقايق شغل (أسرع نتيجة)، لحد 20 جهاز
    workers = max(1, min(MAX_WORKERS, math.ceil(n * per_frame / TARGET_PER_WORKER)))
    if mode == "ai" and n * per_frame / workers > WORKER_BUDGET:   # مقطع طويل كلش: نصغر دخول النموذج حتى يلحگ
        shrink = math.sqrt(WORKER_BUDGET * workers / (n * per_frame))
        mw, mh = even(mw * shrink), even(mh * shrink)
        per_frame *= shrink * shrink
        if max(mw, mh) < 320:
            mode = "ffmpeg"
    if mode == "ffmpeg":
        cap = 3840 if long > 1920 else min(2 * long, 1920)
        k = max(1.0, cap / long) if long <= 1920 else 1.0
        ow, oh = even(w * k), even(h * k)
        workers = max(1, min(MAX_WORKERS, math.ceil(n / 3000)))
    else:
        # Full HD (1920 للضلع الطويل): أوضح بهواية من الأصل ويشتغل سلس بتلكرام على كل الموبايلات
        # (1440×2560 و4K كانت تتقطع على بعض الأجهزة فتبين الصورة متأخرة عن الصوت)
        cap = 1920
        k = min(4 * max(mw, mh), cap) / max(mw, mh)
        ow, oh = even(mw * k), even(mh * k)
    per = math.ceil(n / workers)
    segs = [{"i": i, "start": i * per, "count": max(0, min(per, n - i * per))} for i in range(workers)]
    segs = [x for x in segs if x["count"] > 0]
    eta = (n * per_frame / len(segs)) if mode == "ai" else n / 60
    return {"mode": mode, "mw": mw, "mh": mh, "ow": ow, "oh": oh, "segments": segs, "eta_sec": int(eta)}


def model():
    import torch
    import torch.nn as nn

    class SRVGGNetCompact(nn.Module):  # بنية realesr-general-x4v3 (مطابقة لأوزانها الرسمية)
        def __init__(self, nf=64, nc=32, up=4):
            super().__init__()
            self.up = up
            body = [nn.Conv2d(3, nf, 3, 1, 1), nn.PReLU(num_parameters=nf)]
            for _ in range(nc):
                body += [nn.Conv2d(nf, nf, 3, 1, 1), nn.PReLU(num_parameters=nf)]
            body += [nn.Conv2d(nf, 3 * up * up, 3, 1, 1)]
            self.body = nn.ModuleList(body)
            self.upsampler = nn.PixelShuffle(up)

        def forward(self, x):
            out = x
            for layer in self.body:
                out = layer(out)
            return self.upsampler(out) + nn.functional.interpolate(x, scale_factor=self.up, mode="nearest")

    path = os.path.join(os.environ.get("MODEL_DIR", "models"), "realesr-general-x4v3.pth")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        download(MODEL_URL, path)
    m = SRVGGNetCompact()
    sd = torch.load(path, map_location="cpu")
    m.load_state_dict(sd.get("params", sd))
    torch.set_num_threads(os.cpu_count() or 4)
    return m.eval()


# ───────── المراحل ─────────
def stage_claim():
    """خفيف (بدون أي أدوات): ياخذ أقدم مقطع ينتظر بالطابور ويحفظه — إذا ماكو، الجدولة تخلص بثواني"""
    os.makedirs(WORK, exist_ok=True)
    job = site("claim").get("job")
    if not job:
        log("no pending video")
        return False
    with open(os.path.join(WORK, "job.json"), "w") as f:   # حتى لو صار خلل بعدين نگدر نبلغ المستخدم
        json.dump(job, f)
    log("CLAIMED", job["id"], job.get("file_size"), job.get("duration"))
    return True



def start_times(path):
    """بداية الصورة وبداية الصوت (بالثواني) — حتى نحافظ على الفرق بينهم"""
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "json", path],
                         capture_output=True, text=True).stdout
    v = a = None
    for st in json.loads(out or "{}").get("streams", []):
        t = st.get("start_time")
        t = float(t) if t not in (None, "N/A") else None
        if st.get("codec_type") == "video" and v is None:
            v = t
        elif st.get("codec_type") == "audio" and a is None:
            a = t
    return v, a


def count_frames(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
                          "stream=nb_read_packets", "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()
    return int(out) if out.isdigit() else 0

def stage_prepare(test_url=None):
    os.makedirs(WORK, exist_ok=True)
    if test_url:
        job = {"id": "test", "test": True}
        download(test_url, os.path.join(WORK, "in.mp4"))
    else:
        with open(os.path.join(WORK, "job.json")) as f:   # stage_claim حفظه
            job = json.load(f)
        say(job, "⚙️ بدأت أجهز المقطع للمعالجة…")
        raw = os.path.join(WORK, "in.mp4")
        size = int(job.get("file_size") or 0)
        if MTPROTO:
            mt_download(job, raw)
        elif size and size > BOTAPI_IN:
            raise UserError("المقطع أكبر من 20 ميگا. حاليًا البوت يستلم مقاطع لحد 20 ميگا بس — دز مقطع أصغر أو قصّه.")
        else:
            f = bot_api("getFile", {"file_id": job["file_id"]})
            if not f.get("ok"):
                raise UserError("ما گدرت أنزل المقطع من تلكرام (ممكن حجمه أكبر من 20 ميگا).")
            download(f"https://api.telegram.org/file/bot{BOT}/{f['result']['file_path']}", raw)
    info0 = probe(os.path.join(WORK, "in.mp4"))
    fps = round(info0["fps"], 3)
    # الصوت بمقاطع الموبايل أحيانًا يبدي قبل الصورة أو بعدها بجزء من الثانية: نحافظ على نفس الفرق بالضبط
    v0, a0 = start_times(os.path.join(WORK, "in.mp4"))
    d = (a0 - v0) if (a0 is not None and v0 is not None) else 0.0
    if d > 0.001:
        af = f"asetpts=PTS-STARTPTS,adelay={round(d * 1000)}:all=1"
    elif d < -0.001:
        af = f"asetpts=PTS-STARTPTS,atrim=start={-d:.6f},asetpts=PTS-STARTPTS"
    else:
        af = "asetpts=PTS-STARTPTS"
    log(f"AV_OFFSET video_start={v0} audio_start={a0} -> audio shifted {d:+.3f}s")
    # نوحّد المقطع: يبدي من الصفر، معدل إطارات ثابت + إطار مفتاحي كل ثانية حتى كل جهاز يقص جزئه بالضبط
    sh(["ffmpeg", "-v", "error", "-y", "-i", os.path.join(WORK, "in.mp4"), "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", f"setpts=PTS-STARTPTS,fps={fps}", "-af", af, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10",
        "-g", str(max(1, round(fps))), "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", os.path.join(WORK, "src.mkv")])   # صوت بدون ضغط: ما يضيف تأخير
    info = probe(os.path.join(WORK, "src.mkv"))
    info["fps"] = fps
    info["frames"] = count_frames(os.path.join(WORK, "src.mkv")) or info["frames"]   # العدد الحقيقي، مو تقدير
    plan = plan_for(info)
    job.update({"info": info, "plan": plan})
    with open(os.path.join(WORK, "job.json"), "w") as f:
        json.dump(job, f)
    mins = max(1, round(plan["eta_sec"] / 60))
    say(job, f"🎞 المقطع {info['w']}×{info['h']} ({round(info['duration'])} ثانية). أرفع دقته لـ {plan['ow']}×{plan['oh']} "
             f"على {len(plan['segments'])} جهاز بنفس الوقت… ⏳ تقريبًا {mins}–{mins * 2 + 2} دقيقة.")
    log("PLAN", json.dumps(plan))
    return {"has_job": True, "segments": [x["i"] for x in plan["segments"]]}


def stage_process(seg_index):
    with open(os.path.join(WORK, "job.json")) as f:
        job = json.load(f)
    info, plan = job["info"], job["plan"]
    seg = next(x for x in plan["segments"] if x["i"] == seg_index)
    fps, ow, oh = info["fps"], plan["ow"], plan["oh"]
    out = os.path.join(WORK, f"seg_{seg_index:03d}.mp4")
    # نبدي قبل الإطار بنص إطار: توقيتات الملف مقرّبة للملي ثانية، وبدون هذا ممكن جهاز يبدي بإطار زايد أو ناقص
    # (وبعشرين جهاز يتجمع الفرق ويصير الصوت متقدم أو متأخر)
    start_t = max(0.0, (seg["start"] - 0.5) / fps)
    enc = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{ow}x{oh}", "-r", str(fps), "-i", "-",
           *PLAYABLE, out]
    if plan["mode"] == "ffmpeg":
        sh(["ffmpeg", "-v", "error", "-y", "-ss", f"{start_t:.6f}", "-i", os.path.join(WORK, "src.mkv"), "-frames:v", str(seg["count"]), "-an",
            "-vf", f"hqdn3d=1.2:1.2:5:5,scale={ow}:{oh}:flags=lanczos,unsharp=5:5:0.7:3:3:0.3",
            *PLAYABLE, out])
        return
    import numpy as np
    import torch
    net = model()
    mw, mh = plan["mw"], plan["mh"]
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", f"{start_t:.6f}", "-i", os.path.join(WORK, "src.mkv"),
                            "-frames:v", str(seg["count"]), "-vf", f"scale={mw}:{mh}:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                           stdout=subprocess.PIPE)
    pipe = subprocess.Popen(enc, stdin=subprocess.PIPE)
    frame_bytes = mw * mh * 3
    t0, done = time.time(), 0
    with torch.inference_mode():
        while True:
            buf = dec.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            x = torch.frombuffer(bytearray(buf), dtype=torch.uint8).view(mh, mw, 3).permute(2, 0, 1).float().div_(255).unsqueeze(0)
            y = net(x)
            if (y.shape[-1], y.shape[-2]) != (ow, oh):
                y = torch.nn.functional.interpolate(y, size=(oh, ow), mode="bicubic", align_corners=False, antialias=True)
            pipe.stdin.write(y.clamp_(0, 1).mul_(255).round_().byte().squeeze(0).permute(1, 2, 0).contiguous().numpy().tobytes())
            done += 1
            if done % 25 == 0:
                log(f"seg {seg_index}: {done}/{seg['count']} frames, {(time.time() - t0) / done:.2f}s/frame")
    dec.wait()
    pipe.stdin.close()
    if pipe.wait() != 0:
        raise RuntimeError("encoder failed")
    log(f"SEG_DONE {seg_index} frames={done} seconds={time.time() - t0:.1f}")



def stream_durations(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", path],
                         capture_output=True, text=True).stdout
    d = {st.get("codec_type"): st.get("duration") for st in json.loads(out or "{}").get("streams", [])}
    return d.get("video"), d.get("audio")

def stage_merge():
    with open(os.path.join(WORK, "job.json")) as f:
        job = json.load(f)
    info, plan = job["info"], job["plan"]
    segs = sorted(glob.glob(os.path.join(WORK, "**", "seg_*.mp4"), recursive=True))
    if len(segs) != len(plan["segments"]):
        raise RuntimeError(f"ناقص أجزاء: {len(segs)}/{len(plan['segments'])}")
    lst = os.path.join(WORK, "list.txt")
    with open(lst, "w") as f:
        f.writelines(f"file '{os.path.abspath(s)}'\n" for s in segs)
    out = os.path.join(WORK, "out.mp4")
    sh(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-i", os.path.join(WORK, "src.mkv"),
        "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out])
    vd, ad = stream_durations(out)
    log(f"SYNC frames={count_frames(out)}/{info['frames']} video={vd} audio={ad} source={info['duration']:.3f}")
    limit = 1990 * 1024 * 1024 if MTPROTO or job.get("test") else BOTAPI_OUT
    if os.path.getsize(out) > limit:   # أكبر من حد تلكرام: نعيد الضغط بحجم يناسب
        kbps = max(300, int(limit * 8 / 1024 / max(1, info["duration"]) * 0.92) - 192)
        small = os.path.join(WORK, "out_small.mp4")
        sh(["ffmpeg", "-v", "error", "-y", "-i", out, "-c:v", "libx264", "-preset", "medium", "-b:v", f"{kbps}k", "-maxrate", f"{kbps}k",
            "-bufsize", f"{kbps * 2}k", "-c:a", "copy", "-movflags", "+faststart", small])
        out = small
    size_mb = os.path.getsize(out) / 1024 / 1024
    caption = f"✨ رفعت دقة المقطع: {info['w']}×{info['h']} ← {plan['ow']}×{plan['oh']}"
    log("RESULT", out, f"{size_mb:.1f}MB", caption)
    if job.get("test"):
        return
    say(job, "📤 خلصت! جاري إرسال المقطع…")
    if MTPROTO:
        mt_send(job, out, caption, plan["ow"], plan["oh"], info["duration"])
    else:
        r = bot_api("sendVideo", {"chat_id": job["chat_id"], "caption": caption, "supports_streaming": "true",
                                  "width": plan["ow"], "height": plan["oh"], "duration": int(info["duration"]),
                                  "reply_to_message_id": job["message_id"]},
                    files={"video": ("upscaled.mp4", out, "video/mp4")}, timeout=600)
        if not r.get("ok"):
            raise UserError("خلصت المعالجة بس تلكرام رفض يستلم المقطع (حجمه كبير). جرب مقطع أقصر.")
    if job.get("status_message_id"):
        bot_api("deleteMessage", {"chat_id": job["chat_id"], "message_id": job["status_message_id"]})
    site("finish", id=job["id"], ok=True)


class UserError(Exception):
    pass


def fail(err):
    """يبلغ المستخدم إذا صار خلل، ويعلّم المهمة فاشلة"""
    path = os.path.join(WORK, "job.json")
    job = None
    if os.path.exists(path):
        with open(path) as f:
            job = json.load(f)
    elif os.environ.get("JOB_JSON"):
        job = json.loads(os.environ["JOB_JSON"])
    if not job or job.get("test"):
        return
    msg = str(err) if isinstance(err, UserError) else "صار خلل أثناء رفع دقة المقطع 🙏 جرّب تدزه مرة ثانية."
    say(job, "⚠️ " + msg)
    try:
        site("finish", id=job["id"], ok=False, error=str(err)[:400])
    except Exception:  # noqa: BLE001
        pass


if __name__ == "__main__":
    stage = sys.argv[1]
    try:
        if stage == "claim":
            ok = bool(os.environ.get("TEST_VIDEO_URL")) or stage_claim()
            with open(os.environ.get("GITHUB_OUTPUT", "/dev/null"), "a") as f:
                f.write(f"go={'true' if ok else 'false'}\n")
        elif stage == "prepare":
            res = stage_prepare(os.environ.get("TEST_VIDEO_URL"))
            with open(os.environ.get("GITHUB_OUTPUT", "/dev/null"), "a") as f:
                f.write(f"has_job={'true' if res['has_job'] else 'false'}\n")
                f.write(f"segments={json.dumps(res.get('segments', []))}\n")
        elif stage == "process":
            stage_process(int(sys.argv[2]))
        elif stage == "merge":
            stage_merge()
        elif stage == "fail":
            fail(sys.argv[2] if len(sys.argv) > 2 else "failed")
    except Exception as e:  # noqa: BLE001
        log("ERROR", repr(e))
        if stage in ("claim", "prepare", "merge"):
            fail(e)
        raise
