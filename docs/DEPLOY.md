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

### كل المصادر المجانية المدعومة (22 مصدر نصي)

بدون مفتاح، تشتغل فورًا: Kilo، LLM7، OVHcloud، Pollinations، وWorkers AI (احتياط).

كل مفتاح تضيفه يزيد السعة اليومية. البوابة توزّع الطلبات عليها بالتناوب، وإذا وصل مصدر حده تنتقل للي بعده تلقائيًا.

| المصدر | المتغير | من وين تجيب المفتاح |
|---|---|---|
| Cerebras | `CEREBRAS_API_KEY` | https://cloud.cerebras.ai |
| Groq | `GROQ_API_KEY` | https://console.groq.com/keys |
| Google Gemini | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| NVIDIA NIM | `NVIDIA_API_KEY` | https://build.nvidia.com |
| Mistral | `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys |
| Z.ai (GLM) | `ZAI_API_KEY` | https://z.ai/manage-apikey/apikey-list |
| OpenRouter | `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| GitHub Models | `GITHUB_MODELS_TOKEN` | https://github.com/settings/personal-access-tokens (صلاحية Models) |
| SambaNova | `SAMBANOVA_API_KEY` | https://cloud.sambanova.ai/apis |
| Cohere | `COHERE_API_KEY` | https://dashboard.cohere.com/api-keys |
| Cloudflare (حساب ثاني) | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | https://dash.cloudflare.com/profile/api-tokens |
| Hugging Face | `HF_TOKEN` | https://huggingface.co/settings/tokens |
| Scaleway | `SCALEWAY_API_KEY` | https://console.scaleway.com/iam/api-keys |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | https://vercel.com/dashboard/ai-gateway |
| Nebius | `NEBIUS_API_KEY` | https://studio.nebius.com/settings/api-keys |
| Hyperbolic | `HYPERBOLIC_API_KEY` | https://app.hyperbolic.xyz/settings |
| Kilo / LLM7 / OVH / Pollinations | `KILO_API_KEY` … (اختياري) | تشتغل بدونه، والمفتاح يرفع الحد |

**عدة مفاتيح لنفس المصدر:** ضعها مفصولة بفاصلة، مثل `GROQ_API_KEY="key1,key2"`. إذا وصل مفتاح حده، تنتقل البوابة للمفتاح الثاني بنفس الطلب. استخدمها لمفاتيح فريقك أو مشاريعك. لا تفتح حسابات وهمية متعددة، لأن أغلب المنصات تمنع هذا بشروطها وتحظر الحسابات.

**أي مصدر جديد متوافق مع OpenAI** تضيفه بدون تعديل الكود، عن طريق المتغير `EXTRA_PROVIDERS`:

```json
[{"id":"myapi","url":"https://host/v1","key":"MYAPI_KEY","models":["model-name"],"cap":"وصف السعة"}]
```

**إذا تغيّرت أسماء النماذج:** ضع `<ID>_MODELS`، مثل `GITHUB_MODELS="openai/gpt-4.1,openai/gpt-4o"`.

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
