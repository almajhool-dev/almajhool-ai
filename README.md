# المبرمج المجهول AI

منصة كاملة لبناء وتدريب وتطوير نموذج لغوي خاص بك. تُغذّيه بالبيانات تدريجيًا، وتقيس تقدّمه بأرقام حقيقية، وتنشره كـ API.

**لوحة التحكم:** https://almajhool-dev.github.io/almajhool-ai/

```
                ┌──────────────── لوحة التحكم (GitHub Pages / web/) ────────────────┐
                │ اللوحة · البيانات · التدريب · الدردشة · الصور · بناء المواقع · الإعدادات │
                └───────────────┬──────────────────────────────────┬───────────────┘
                                │ REST + /v1 (OpenAI)              │ /api/chat · /api/image
                ┌───────────────▼───────────────┐   ┌──────────────▼──────────────┐
                │ server/ (FastAPI) على GPU     │   │ gateway/ (Cloudflare Worker) │
                │  Dataset Manager · Trainer     │   │  Groq · Cerebras · Gemini    │
                │  Model/Checkpoint Manager      │   │  OpenRouter · FLUX (صور)     │
                │  Evaluation · Backups · API    │   │  + خادم MCP لكلود             │
                └───────────────────────────────┘   └─────────────────────────────┘
```

## وضعان للتشغيل

| الوضع | يحتاج | ماذا يعطيك |
|---|---|---|
| **وضع التجربة** | البوابة المجانية فقط | دردشة، توليد صور، بناء مواقع وتطبيقات — مباشرة من GitHub Pages |
| **وضع المحرك** | GPU (Colab/Kaggle مجانًا، أو سيرفر) | إضافة البيانات، التدريب، الإصدارات، التقييم، والدردشة مع **نموذجك أنت** |

> بالوضع الأول تتكلم مع نماذج مفتوحة عبر البوابة، وليس مع نموذجك. نموذجك يصير موجودًا بعد أول تدريب.

## البدء السريع

```bash
git clone https://github.com/almajhool-dev/almajhool-ai && cd almajhool-ai
pip install -r requirements.txt

almajhool() { python -m almajhool "$@"; }      # أو: pip install -e ".[train]"
almajhool add-data my_data/*.jsonl --note "أول دفعة"
almajhool train --epochs 1                      # → v1
almajhool serve                                 # اللوحة + API على http://localhost:8000
```

التفاصيل الكاملة موجودة في:
- [`docs/DEPLOY.md`](docs/DEPLOY.md): Colab، Kaggle، السيرفر، البوابة، و Hugging Face.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): سبب اختيار النموذج، وكيف يتوسع لمليارات التوكنات.
- [`notebooks/train_colab.ipynb`](notebooks/train_colab.ipynb): تدريب مجاني على GPU بضغطة.

## الأوامر

| الأمر | الوظيفة |
|---|---|
| `add-data FILES… [--note]` | تنظيف + إزالة تكرار + ترميز + إصدار داتاسيت جديد (TXT/JSON/JSONL/CSV/MD) |
| `datasets` | الإصدارات v1, v2… وعدد التوكنات والمستندات بكل إصدار |
| `train [--dataset vN] [--parent vX] [--epochs --lr --lora-rank --context-length …]` | تدريب جديد أو مواصلة تدريب إصدار سابق |
| `train --resume-run RUN_ID` | استكمال من آخر Checkpoint بعد توقف أو انقطاع |
| `stop RUN_ID` | إيقاف آمن مع حفظ Checkpoint |
| `models` / `runs` / `checkpoints` | الإصدارات، عمليات التدريب، ونقاط الحفظ |
| `eval vX --compare vY` | مقارنة الجودة الفعلية بين إصدارين |
| `backup [--hub user/repo]` / `restore FILE` | نسخ احتياطي مع تحقق SHA-256، واستعادة آمنة |
| `merge vX` / `push vX user/repo [--merged]` | دمج الـ LoRA والنشر على Hugging Face |
| `retokenize vN --tokenizer MODEL` | إعادة ترميز البيانات عند تغيير عائلة النموذج |

## بنية المشروع

```
almajhool/
  config.py             الإعدادات (config/default.yaml)
  tokenizer.py          Tokenizer النموذج + قوالب المحادثة
  dataset/
    readers.py          قراءة متدفقة لكل الصيغ (لا تحميل كامل للذاكرة)
    cleaning.py         تنظيف، كشف النصوص التالفة، إزالة التكرار (SQLite على القرص)
    shards.py           شاردات توكنات ثنائية تُقرأ بـ memmap
    manager.py          الإصدارات v1, v2… والإضافة التدريجية
    packed.py           Dataset التدريب (Packing بطول السياق)
  training/trainer.py   LoRA/QLoRA/Full، Checkpoints، استكمال، Multi-GPU
  models/
    manager.py          إصدارات النموذج v1, v1.1, v2 + الدمج
    checkpoints.py      Checkpoints، نسخ احتياطي، استعادة، رفع للـ Hub
    loader.py           تحميل موحّد (4-bit / bf16)
  evaluation/           Perplexity + أسئلة ثابتة + حكم مقارنة
  inference.py          محرك الدردشة + النشر على HF
  cli.py                سطر الأوامر
server/app.py           FastAPI: API اللوحة + /v1/chat/completions
web/                    لوحة التحكم (HTML/CSS/JS بدون بناء)
gateway/                Cloudflare Worker: نماذج مجانية + صور FLUX + MCP
config/                 الإعدادات + أسئلة التقييم
notebooks/              Colab
tests/                  اختبارات (تعمل بدون GPU)
```

## الصدق في القياس

حجم الداتاسيت وحده لا يجعل النموذج أذكى. لذلك بعد كل تدريب يُقيَّم النموذج تلقائيًا ويُقارَن بالإصدار السابق:
- **Perplexity** على بيانات محجوزة لم يتدرّب عليها.
- **أسئلة ثابتة** (`config/eval_prompts.jsonl`): يُقاس فيها وجود المعلومة المتوقعة، والتكرار، ونسبة العربية.
- **الحكم** يكون واحدًا من: تحسّن، تراجع، بلا تغيير، أو مختلط. الحكم "مختلط" يعني أن الـ perplexity تحسّن لكن الأجوبة ساءت.

أضف أسئلتك الخاصة إلى `eval_prompts.jsonl` حتى يقيس التقييم ما يهمك فعلًا.
