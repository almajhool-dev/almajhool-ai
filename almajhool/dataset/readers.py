"""قرّاء الملفات بنمط Streaming — لا يُحمَّل أي ملف بالكامل إلى الذاكرة.

كل قارئ يُنتج مستندات بالشكل:
    {"text": "..."}                       نص عادي
    {"messages": [{"role", "content"}]}   محادثة (تعليمات/أسئلة وأجوبة)
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path
from typing import Any, Iterator

SUPPORTED = {".txt", ".md", ".markdown", ".json", ".jsonl", ".csv"}

TEXT_KEYS = ("text", "content", "body", "article", "document", "النص")
PROMPT_KEYS = ("instruction", "prompt", "question", "input_text", "السؤال")
INPUT_KEYS = ("input", "context")
ANSWER_KEYS = ("output", "response", "answer", "completion", "الجواب")

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))


def record_to_doc(rec: Any) -> dict | None:
    """يحوّل سجل JSON/CSV بأي شكل شائع إلى مستند موحّد."""
    if isinstance(rec, str):
        return {"text": rec}
    if not isinstance(rec, dict):
        return None
    msgs = rec.get("messages") or rec.get("conversations")
    if isinstance(msgs, list) and msgs:
        out = []
        for m in msgs:
            if not isinstance(m, dict):
                continue
            role = m.get("role") or m.get("from") or "user"
            role = {"human": "user", "gpt": "assistant", "bot": "assistant"}.get(role, role)
            content = m.get("content") or m.get("value") or ""
            if content:
                out.append({"role": role, "content": str(content)})
        return {"messages": out} if out else None
    prompt = next((rec[k] for k in PROMPT_KEYS if rec.get(k)), None)
    answer = next((rec[k] for k in ANSWER_KEYS if rec.get(k)), None)
    if prompt and answer:
        extra = next((rec[k] for k in INPUT_KEYS if rec.get(k)), None)
        user = f"{prompt}\n\n{extra}" if extra else str(prompt)
        msgs = []
        if rec.get("system"):
            msgs.append({"role": "system", "content": str(rec["system"])})
        msgs += [{"role": "user", "content": user}, {"role": "assistant", "content": str(answer)}]
        return {"messages": msgs}
    text = next((rec[k] for k in TEXT_KEYS if rec.get(k)), None)
    if text:
        return {"text": str(text)}
    return None


def _read_text(path: Path, max_chars: int) -> Iterator[dict]:
    """يقسّم الملف النصي إلى مستندات عند الأسطر الفارغة المزدوجة، بحد أقصى max_chars."""
    buf: list[str] = []
    size = 0
    blank_run = 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if not line.strip():
                blank_run += 1
                # ثلاث أسطر فارغة متتالية = فاصل مستندات
                if blank_run >= 3 and buf:
                    yield {"text": "".join(buf)}
                    buf, size = [], 0
                    continue
            else:
                blank_run = 0
            buf.append(line)
            size += len(line)
            if size >= max_chars:
                yield {"text": "".join(buf)}
                buf, size = [], 0
    if buf:
        yield {"text": "".join(buf)}


def _read_jsonl(path: Path) -> Iterator[dict]:
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                doc = record_to_doc(json.loads(line))
            except json.JSONDecodeError:
                yield {"_invalid": "bad_json"}
                continue
            yield doc if doc else {"_invalid": "unknown_schema"}


def _read_json(path: Path) -> Iterator[dict]:
    try:
        import ijson  # Streaming JSON parser للملفات الضخمة

        with open(path, "rb") as f:
            first = f.read(1)
            while first and first.isspace():
                first = f.read(1)
            f.seek(0)
            prefix = "item" if first == b"[" else None
            if prefix:
                for rec in ijson.items(f, "item"):
                    doc = record_to_doc(rec)
                    yield doc if doc else {"_invalid": "unknown_schema"}
                return
    except ImportError:
        pass
    with open(path, encoding="utf-8", errors="replace") as f:
        data = json.load(f)
    if isinstance(data, dict):
        # {"data": [...]} أو مستند واحد
        items = next((v for v in data.values() if isinstance(v, list)), None)
        data = items if items is not None else [data]
    for rec in data:
        doc = record_to_doc(rec)
        yield doc if doc else {"_invalid": "unknown_schema"}


def _read_csv(path: Path) -> Iterator[dict]:
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        sample = f.read(4096)
        f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        for row in csv.DictReader(f, dialect=dialect):
            row = {(k or "").strip().lower(): v for k, v in row.items()}
            doc = record_to_doc(row)
            if doc is None:
                # لا يوجد عمود معروف: ندمج كل الأعمدة النصية
                text = " ".join(v for v in row.values() if isinstance(v, str) and v.strip())
                doc = {"text": text} if text else None
            yield doc if doc else {"_invalid": "empty_row"}


def read_documents(path: str | Path, max_chars: int = 200_000) -> Iterator[dict]:
    path = Path(path)
    ext = path.suffix.lower()
    if ext in (".txt", ".md", ".markdown"):
        yield from _read_text(path, max_chars)
    elif ext == ".jsonl":
        yield from _read_jsonl(path)
    elif ext == ".json":
        yield from _read_json(path)
    elif ext == ".csv":
        yield from _read_csv(path)
    else:
        raise ValueError(f"صيغة غير مدعومة: {ext} (المدعوم: {', '.join(sorted(SUPPORTED))})")
