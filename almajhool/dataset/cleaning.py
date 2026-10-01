"""تنظيف البيانات واكتشاف النصوص غير الصالحة وإزالة التكرار."""
from __future__ import annotations

import hashlib
import re
import sqlite3
import unicodedata
from pathlib import Path

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​﻿]")
_MULTI_SPACE = re.compile(r"[ \t ]{2,}")
_MULTI_NL = re.compile(r"\n{4,}")
_TATWEEL = re.compile(r"ـ{2,}")
_REPEAT_CHAR = re.compile(r"(.)\1{15,}")
_HTML_TAG = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.S | re.I)


def clean_text(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = _HTML_TAG.sub(" ", text)
    text = _CONTROL.sub("", text)
    text = _TATWEEL.sub("ـ", text)
    text = _REPEAT_CHAR.sub(lambda m: m.group(1) * 3, text)
    text = _MULTI_SPACE.sub(" ", text)
    text = _MULTI_NL.sub("\n\n\n", text)
    return text.strip()


def invalid_reason(text: str, cfg: dict) -> str | None:
    """يرجع سبب الرفض، أو None إذا كان النص صالحًا."""
    n = len(text)
    if n < cfg["min_chars"]:
        return "too_short"
    letters = sum(1 for c in text if c.isalpha())
    if letters / n < cfg["min_letter_ratio"]:
        return "low_letter_ratio"  # أرقام/رموز/ترميز تالف
    if text.count("�") > max(5, n * 0.01):
        return "encoding_errors"
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if len(lines) >= 10:
        unique = len(set(lines))
        if 1 - unique / len(lines) > cfg["max_repeated_line_ratio"]:
            return "repeated_lines"  # قوائم تنقل، تذييلات مكررة...
    return None


def clean_doc(doc: dict, cfg: dict) -> tuple[dict | None, str | None]:
    if "_invalid" in doc:
        return None, doc["_invalid"]
    if "messages" in doc:
        msgs = []
        for m in doc["messages"]:
            c = clean_text(m["content"])
            if c:
                msgs.append({"role": m["role"], "content": c})
        if not any(m["role"] == "assistant" for m in msgs):
            return None, "no_assistant_turn"
        total = "\n".join(m["content"] for m in msgs)
        if len(total) < cfg["min_chars"]:
            return None, "too_short"
        return {"messages": msgs}, None
    text = clean_text(doc["text"])
    reason = invalid_reason(text, cfg)
    return (None, reason) if reason else ({"text": text}, None)


def doc_fingerprint(doc: dict) -> bytes:
    """بصمة 16 بايت بعد تطبيع خفيف (حالة الأحرف والمسافات) لاكتشاف التكرار."""
    if "messages" in doc:
        raw = "\x1e".join(f"{m['role']}\x1f{m['content']}" for m in doc["messages"])
    else:
        raw = doc["text"]
    norm = re.sub(r"\s+", " ", raw.lower()).strip()
    return hashlib.blake2b(norm.encode("utf-8"), digest_size=16).digest()


class DedupIndex:
    """فهرس بصمات على القرص (SQLite) — يتحمّل مئات الملايين من المستندات بدون RAM كبيرة."""

    def __init__(self, path: str | Path):
        self.conn = sqlite3.connect(str(path))
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("CREATE TABLE IF NOT EXISTS seen (h BLOB PRIMARY KEY) WITHOUT ROWID")

    def add_if_new(self, fp: bytes) -> bool:
        # لا نعمل commit هنا: الدفعة كلها معاملة واحدة، فإذا فشلت المعالجة
        # ترجع البصمات تلقائيًا ولا تُحسب المستندات "مكررة" ظلمًا في المرة القادمة.
        cur = self.conn.execute("INSERT OR IGNORE INTO seen (h) VALUES (?)", (fp,))
        return cur.rowcount == 1

    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM seen").fetchone()[0]

    def close(self, commit: bool = True) -> None:
        if commit:
            self.conn.commit()
        else:
            self.conn.rollback()
        self.conn.close()
