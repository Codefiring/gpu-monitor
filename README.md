# GPU Monitor

一个单机 NVIDIA GPU 使用情况监控网站。后端使用 FastAPI 和 `nvidia-ml-py` 读取 NVML 指标，默认每 5 秒采样一次并写入 SQLite，保留 30 天历史数据。

## 功能

- 实时展示每张 GPU 的核心利用率、显存利用率、显存用量、温度和功耗。
- 绘制最近 10 分钟、30 分钟、1 小时或 6 小时的 GPU/显存利用率曲线。
- 按自定义时间段统计平均值和最大值。
- 原生前端，无需前端构建工具。

## 运行

服务器需要先安装可用的 NVIDIA 驱动，并确保 `nvidia-smi` 可以正常输出。

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

然后访问：

```text
http://服务器IP:8000
```

## 配置

可以通过环境变量调整运行参数：

```bash
GPU_MONITOR_DB=/path/to/gpu_metrics.sqlite3
GPU_MONITOR_SAMPLE_INTERVAL=5
GPU_MONITOR_RETENTION_DAYS=30
GPU_MONITOR_DEFAULT_HISTORY_MINUTES=10
```

默认数据库路径是 `data/gpu_metrics.sqlite3`。
