# التشغيل والنشر

## أ) لوحة التحكم على GitHub Pages

تُنشر تلقائيًا من مجلد `web/` عند كل push، عن طريق الملف `.github/workflows/pages.yml`.

أول مرة فقط: افتح المستودع، ثم **Settings → Pages → Source: GitHub Actions**.

الرابط: `https://almajhool-dev.github.io/almajhool-ai/`

## ب) البوابة المجانية (دردشة + صور + بناء مواقع)

```bash
npm install -g wrangler
wrangler login
cd gateway
wrangler secret put ACCESS_TOKEN        # كلمة سر طويلة عشوائية
wrangler secret put GROQ_API_KEY        # https://console.groq.com/keys
wrangler secret put CEREBRAS_API_KEY    # https://cloud.cerebras.ai
wrangler secret put GEMINI_API_KEY      # https://aistudio.google.com/apikey
wrangler secret put OPENROUTER_API_KEY  # https://openrouter.ai/keys
wrangler deploy
```

مفتاح واحد يكفي للبداية. توليد الصور يعمل عبر Workers AI (FLUX) وما يحتاج مفتاح، فقط حساب Cloudflare.

بعد النشر افتح اللوحة، ثم **الإعدادات ← البوابة المجانية**، وضع الرابط والـ ACCESS_TOKEN.

**ربطها بكلود:** claude.ai، ثم Settings، ثم Connectors، ثم Add custom connector، وضع الرابط:
`https://free-ai-gateway.<you>.workers.dev/mcp/<ACCESS_TOKEN>`

## ج) المحرك على Colab أو Kaggle (GPU مجاني)

افتح `notebooks/train_colab.ipynb` في Colab، واختر Runtime ثم T4 GPU، وشغّل الخلايا بالترتيب.

الدفتر يقوم بما يلي:
1. يثبّت المشروع، ويربط Google Drive حتى تبقى البيانات والـ Checkpoints بعد انتهاء الجلسة.
2. يشغّل الخادم، ويفتح نفقًا مجانيًا (cloudflared) يعطيك رابط `https://….trycloudflare.com`.
3. تضع الرابط في **الإعدادات ← المحرك** في اللوحة، وتتحكم بكل شي من هناك: رفع البيانات، والتدريب، والدردشة مع نموذجك.

جلسات Colab المجانية تنقطع. لهذا كل الحالة محفوظة في Drive، ولما ترجع تختار "استكمال" في خانة **Checkpoint** بصفحة التدريب.

## د) سيرفر GPU خاص

```bash
git clone https://github.com/almajhool-dev/almajhool-ai && cd almajhool-ai
python -m venv .venv && source .venv/bin/activate
pip install -e ".[train]"
export ALMAJHOOL_API_KEY="كلمة-سر-قوية"       # حماية الـ API
export ALMAJHOOL_HOME=/data/almajhool          # مكان البيانات (قرص كبير)
almajhool serve --port 8000
```

- **عدة GPUs:** الخادم يستخدم `torchrun` تلقائيًا. يدويًا: `torchrun --nproc_per_node=4 -m almajhool.cli train --dataset v3`.
- ضع الخادم خلف HTTPS (مثل Caddy أو Nginx أو Cloudflare Tunnel) حتى تتصل به اللوحة المنشورة على GitHub Pages.

## هـ) استخدام النموذج من أي تطبيق (API متوافق مع OpenAI)

```bash
curl https://your-server/v1/chat/completions \
  -H "Authorization: Bearer $ALMAJHOOL_API_KEY" -H "Content-Type: application/json" \
  -d '{"model": "latest", "messages": [{"role": "user", "content": "مرحبا"}]}'
```

`model` يقبل `latest` (الإصدار النشط)، أو رقم إصدار مثل `v1.2`، أو `base`. ويدعم `stream: true`.

## و) النشر على Hugging Face

```bash
huggingface-cli login
almajhool push v1.2 almajhool-dev/almajhool-ai-v1.2            # Adapter فقط (خفيف)
almajhool push v1.2 almajhool-dev/almajhool-ai-v1.2 --merged   # نموذج كامل مدموج (لـ vLLM/Ollama)
almajhool backup --hub almajhool-dev/almajhool-backups          # نسخة احتياطية خاصة
```

للتشغيل بإنتاجية عالية: `vllm serve almajhool-dev/almajhool-ai-v1.2`، وهو أيضًا API متوافق مع OpenAI.

## صيغ البيانات المقبولة

| الصيغة | الشكل |
|---|---|
| `.txt` / `.md` | نص حر. ثلاثة أسطر فارغة متتالية تعني بداية مستند جديد |
| `.jsonl` / `.json` | `{"text": …}`، أو `{"instruction": …, "output": …}`، أو `{"messages": [{"role", "content"}]}` |
| `.csv` | عمود `text`، أو `instruction`/`output`، أو `question`/`answer`. وإن لم يوجد عمود معروف تُدمج كل الأعمدة |

بيانات المحادثة (الأسئلة والأجوبة) تُنسَّق تلقائيًا بقالب المحادثة الخاص بالنموذج.
