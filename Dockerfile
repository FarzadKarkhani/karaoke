# Processing backend (vocal removal, lyric timing, MP4 export). The Vercel-hosted UI talks to this.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY karaoke ./karaoke

# CPU-only PyTorch (the default Linux wheel pulls gigabytes of CUDA libraries), then the app,
# then the headless browser (+ its system libraries) used to draw video frames.
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir ".[studio]" \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Projects, uploads, renders and downloaded AI models live on the volume.
ENV KARAOKE_DATA=/data HF_HOME=/data/cache/huggingface TORCH_HOME=/data/cache/torch
VOLUME /data
EXPOSE 8000

# Set KARAOKE_TOKEN and KARAOKE_CORS_ORIGINS (your Vercel URL) when you run it.
CMD ["python", "-m", "karaoke", "--host", "0.0.0.0", "--port", "8000", "--no-browser"]
