# نحول نموذج Real-ESRGAN (realesr-general-x4v3) إلى ONNX حتى يشتغل داخل سيرفر البوت (Node) بدون Python
import os, sys, time
sys.path.insert(0, "video")
os.environ["MODEL_DIR"] = "models"
import numpy as np, torch
import upscale
m = upscale.model()
x = torch.rand(1, 3, 64, 64)
torch.onnx.export(m, x, "probe_out/realesr-general-x4v3.onnx", input_names=["input"], output_names=["output"],
                  dynamic_axes={"input": {2: "h", 3: "w"}, "output": {2: "H", 3: "W"}}, opset_version=17, dynamo=False)
print("ONNX size", os.path.getsize("probe_out/realesr-general-x4v3.onnx"))
import onnxruntime as ort
s = ort.InferenceSession("probe_out/realesr-general-x4v3.onnx", providers=["CPUExecutionProvider"])
t = torch.rand(1, 3, 128, 96)
a = m(t).detach().numpy(); b = s.run(None, {"input": t.numpy()})[0]
print("max diff torch vs onnx", float(np.abs(a - b).max()), b.shape)
for size in (256, 512, 768):
    z = np.random.rand(1, 3, size, size).astype("float32"); st = time.time(); s.run(None, {"input": z}); print(f"ORT {size}x{size}: {time.time()-st:.2f}s")
