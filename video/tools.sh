#!/usr/bin/env bash
# تنصيب الأدوات بدون ما يعلگ: كل محاولة إلها وقت محدود، وإذا مرآة apt علگت ناخذ ffmpeg جاهز من GitHub.
# الاستعمال: bash video/tools.sh [torch]
set -u
retry() { local n=0; until "$@"; do n=$((n+1)); [ $n -ge 3 ] && return 1; echo "retry $n: $*"; sleep 3; done; }

if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  if ! (timeout 60 sudo apt-get -qq -o Acquire::Retries=2 -o Acquire::http::Timeout=15 update >/dev/null \
        && timeout 120 sudo apt-get -qq -o Acquire::http::Timeout=15 install -y --no-install-recommends ffmpeg >/dev/null); then
    echo "apt was slow — using the static ffmpeg build"
    URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz
    retry timeout 120 curl -fsSL --retry 3 -o /tmp/ff.tar.xz "$URL" || exit 1
    mkdir -p /tmp/ff && tar -xJf /tmp/ff.tar.xz -C /tmp/ff --strip-components=1 \
      && sudo install -m 755 /tmp/ff/bin/ffmpeg /tmp/ff/bin/ffprobe /usr/local/bin/ || exit 1
  fi
fi
ffmpeg -version | head -1

PIP="pip -q install --timeout 30 --retries 5"
if [ "${1:-}" = "torch" ]; then
  retry timeout 300 $PIP torch --index-url https://download.pytorch.org/whl/cpu || exit 1
  retry timeout 120 $PIP numpy || exit 1
else
  retry timeout 120 $PIP telethon || exit 1
fi
