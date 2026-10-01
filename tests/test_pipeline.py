"""اختبارات خط البيانات — تعمل بدون GPU وبدون إنترنت (ByteTokenizer)."""
import json

import numpy as np
import pytest

from almajhool.config import load_config
from almajhool.dataset.cleaning import clean_doc, invalid_reason
from almajhool.dataset.manager import DatasetManager
from almajhool.dataset.readers import read_documents, record_to_doc
from almajhool.dataset.shards import open_shard


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.setenv("ALMAJHOOL_HOME", str(tmp_path / "ws"))
    c = load_config()
    c["model"]["base"] = "byte"
    c["data"]["shard_tokens"] = 4000   # شاردات صغيرة لاختبار التقسيم
    c["data"]["eval_permille"] = 100
    return c


def write_samples(d):
    para = "هذا نص عربي تجريبي عن الأمن الرقمي وحماية الحسابات من الاختراق. "
    (d / "a.txt").write_text("\n\n\n".join(para * 3 + str(i) for i in range(40)), encoding="utf-8")
    (d / "b.jsonl").write_text("\n".join(
        [json.dumps({"instruction": f"سؤال رقم {i} عن البرمجة؟", "output": f"هذا جواب مفصل رقم {i} عن البرمجة والتطوير."},
                    ensure_ascii=False) for i in range(30)]
        + ["{bad json", json.dumps({"foo": 1})]), encoding="utf-8")
    (d / "c.csv").write_text("text,label\n" + "\n".join(f'"{para} سطر {i}",x' for i in range(20)), encoding="utf-8")
    (d / "d.json").write_text(json.dumps([{"messages": [{"role": "user", "content": "مرحبا كيف الحال اليوم؟"},
                                                       {"role": "assistant", "content": f"أهلا! بخير والحمد لله {i}"}]}
                                         for i in range(10)], ensure_ascii=False), encoding="utf-8")
    (d / "e.md").write_text("# عنوان\n\n" + para * 5, encoding="utf-8")


def test_record_formats():
    assert record_to_doc({"text": "x"}) == {"text": "x"}
    assert record_to_doc({"prompt": "q", "response": "a"})["messages"][1]["content"] == "a"
    assert record_to_doc({"conversations": [{"from": "human", "value": "hi"}, {"from": "gpt", "value": "yo"}]})[
        "messages"][1]["role"] == "assistant"
    assert record_to_doc({"nothing": 1}) is None


def test_cleaning_rules(cfg):
    d = cfg["data"]
    assert invalid_reason("قصير", d) == "too_short"
    assert invalid_reason("1234567890 " * 10, d) == "low_letter_ratio"
    assert invalid_reason("\n".join(["same line here ok"] * 20), d) == "repeated_lines"
    doc, r = clean_doc({"text": "نص   فيه    مسافات\x00 كثيرة وهو طويل بما يكفي للقبول هنا"}, d)
    assert r is None and "  " not in doc["text"] and "\x00" not in doc["text"]


def test_ingest_versions_dedup(cfg, tmp_path):
    src = tmp_path / "src"; src.mkdir(); write_samples(src)
    dm = DatasetManager(cfg)
    rep = dm.add_files(sorted(src.iterdir()), note="أول دفعة")
    assert rep["version"] == "v1"
    t = rep["totals"]
    assert t["docs_kept"] > 0 and t["train_tokens"] > 0 and t["eval_tokens"] > 0
    assert t["invalid"] >= 2  # السطر التالف + السجل غير المعروف
    v1 = dm.get_version("v1")
    assert len(v1["train_shards"]) > 1, "يجب أن تُقسّم البيانات لعدة شاردات"
    # كل شارد يُقرأ عبر memmap وعدد التوكنات مطابق للسجل
    total = sum(len(open_shard(dm.shard_dir("byte"), s)) for s in v1["train_shards"] + v1["eval_shards"])
    assert total == v1["stats"]["total_tokens"]

    # نفس الملفات مرة ثانية → لا إصدار جديد
    rep2 = dm.add_files(sorted(src.iterdir()))
    assert rep2["version"] is None

    # ملف جديد فيه مستندات مكررة + جديدة → v2 يحتوي v1 كاملًا + الجديد فقط
    new = tmp_path / "new.jsonl"
    new.write_text("\n".join([json.dumps({"instruction": "سؤال رقم 1 عن البرمجة؟", "output": "هذا جواب مفصل رقم 1 عن البرمجة والتطوير."}, ensure_ascii=False),
                              json.dumps({"text": "مستند جديد تماما عن الذكاء الاصطناعي وتدريب النماذج اللغوية الكبيرة."}, ensure_ascii=False)]),
                   encoding="utf-8")
    rep3 = dm.add_files([new])
    assert rep3["version"] == "v2"
    assert rep3["totals"]["duplicates"] == 1 and rep3["totals"]["docs_kept"] == 1
    v2 = dm.get_version("v2")
    assert v2["parent"] == "v1"
    assert v2["train_shards"][:len(v1["train_shards"])] == v1["train_shards"]
    assert v2["stats"]["total_tokens"] > v1["stats"]["total_tokens"]
    assert dm.overview()["current_version"] == "v2"


def test_failed_ingest_rolls_back(cfg, tmp_path, monkeypatch):
    src = tmp_path / "x.txt"
    src.write_text("نص صالح للتدريب عن البرمجة والأمن الرقمي " * 5, encoding="utf-8")
    dm = DatasetManager(cfg)
    import almajhool.dataset.manager as m

    orig = m.DatasetManager._ingest_file

    def boom(self, *a, **k):
        orig(self, *a, **k)
        raise RuntimeError("انقطاع مفاجئ")

    monkeypatch.setattr(m.DatasetManager, "_ingest_file", boom)
    with pytest.raises(RuntimeError):
        dm.add_files([src])
    monkeypatch.setattr(m.DatasetManager, "_ingest_file", orig)
    assert dm.versions() == []
    assert not list(dm.shard_dir("byte").glob("*.bin"))
    rep = dm.add_files([src])  # إعادة المحاولة تنجح ولا تُعتبر البيانات مكررة
    assert rep["version"] == "v1" and rep["totals"]["duplicates"] == 0


def test_packed_dataset(cfg, tmp_path):
    torch = pytest.importorskip("torch")
    from almajhool.dataset.packed import PackedTokenDataset

    src = tmp_path / "src"; src.mkdir(); write_samples(src)
    dm = DatasetManager(cfg); dm.add_files(sorted(src.iterdir()))
    v = dm.get_version("v1")
    ds = PackedTokenDataset(dm.shard_dir("byte"), v["train_shards"], 64)
    assert len(ds) > 10
    item = ds[len(ds) - 1]
    assert item["input_ids"].shape == (64,) and item["input_ids"].dtype == torch.int64


def test_backup_restore(cfg, tmp_path):
    from almajhool.models.checkpoints import BackupManager

    src = tmp_path / "src"; src.mkdir(); write_samples(src)
    dm = DatasetManager(cfg); dm.add_files(sorted(src.iterdir()))
    bm = BackupManager(cfg)
    b = bm.create()
    assert bm.verify(b["archive"])["ok"]
    reg = dm.paths.registry
    reg.write_text("{}")  # تلف متعمد
    res = bm.restore(b["archive"])
    assert dm.get_version("v1")
    assert (dm.paths.root / res["previous_state_saved_to"]).exists()


def test_model_versioning(cfg):
    from almajhool.models.manager import ModelManager

    mm = ModelManager(cfg)
    assert mm.next_version(None) == "v1"
    mm.register({"version": "v1", "base_model": "byte", "parent": None, "dataset_version": "v1"})
    assert mm.next_version("v1") == "v1.1"
    mm.register({"version": "v1.1", "base_model": "byte", "parent": "v1", "dataset_version": "v2"})
    assert mm.next_version("v1.1") == "v1.2"
    assert mm.next_version("v1.1", "major") == "v2"
    assert [v["version"] for v in mm.lineage("v1.1")] == ["v1", "v1.1"]
    assert mm.active()["version"] == "v1.1"
