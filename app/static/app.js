const state = {
  gpus: [],
  latestByGpu: new Map(),
  charts: new Map(),
  timer: null,
};

const colors = {
  gpu: "#147d73",
  memory: "#7a4cc2",
  temp: "#bd5b00",
  power: "#2f6fbb",
  grid: "#dfe6ee",
  text: "#152033",
  muted: "#65758b",
};

const els = {
  status: document.getElementById("statusText"),
  gpuGrid: document.getElementById("gpuGrid"),
  historyWindow: document.getElementById("historyWindow"),
  refreshButton: document.getElementById("refreshButton"),
  statsGpu: document.getElementById("statsGpu"),
  statsFrom: document.getElementById("statsFrom"),
  statsTo: document.getElementById("statsTo"),
  statsButton: document.getElementById("statsButton"),
  statsResult: document.getElementById("statsResult"),
};

document.addEventListener("DOMContentLoaded", async () => {
  setDefaultStatsRange();
  await refreshAll();
  state.timer = window.setInterval(refreshAll, 5000);
});

els.refreshButton.addEventListener("click", refreshAll);
els.historyWindow.addEventListener("change", refreshAll);
els.statsButton.addEventListener("click", loadStats);

async function refreshAll() {
  try {
    const [gpusResponse, latestResponse] = await Promise.all([
      fetchJson("/api/gpus"),
      fetchJson("/api/metrics/latest"),
    ]);

    state.gpus = gpusResponse.gpus || [];
    state.latestByGpu = new Map(
      (latestResponse.metrics || []).map((metric) => [metric.gpu_index, metric]),
    );

    if (gpusResponse.error) {
      els.status.innerHTML = `<span class="error">${escapeHtml(gpusResponse.error)}</span>`;
    } else if (latestResponse.collector_error) {
      els.status.innerHTML = `<span class="error">${escapeHtml(latestResponse.collector_error)}</span>`;
    } else {
      els.status.textContent = `已连接，${state.gpus.length} 张 GPU，每 5 秒刷新`;
    }

    renderGpuCards();
    renderStatsGpuOptions();
    await refreshCharts();
  } catch (error) {
    els.status.innerHTML = `<span class="error">连接失败：${escapeHtml(error.message)}</span>`;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function renderGpuCards() {
  if (!state.gpus.length) {
    els.gpuGrid.innerHTML = `<div class="empty">未检测到 GPU 数据<br />请确认服务器 NVIDIA 驱动和 NVML 可用</div>`;
    return;
  }

  els.gpuGrid.innerHTML = state.gpus.map(renderGpuCard).join("");
  for (const gpu of state.gpus) {
    state.charts.set(gpu.index, document.getElementById(`chart-${gpu.index}`));
  }
}

function renderGpuCard(gpu) {
  const latest = state.latestByGpu.get(gpu.index) || {};
  return `
    <article class="gpu-card">
      <div class="gpu-title">
        <h2>${escapeHtml(gpu.name)}</h2>
        <span class="gpu-index">GPU ${gpu.index}</span>
      </div>
      <div class="metric-grid">
        ${metric("GPU", percent(latest.gpu_utilization))}
        ${metric("显存", percent(latest.memory_utilization))}
        ${metric("显存用量", memoryText(latest.memory_used_mb, latest.memory_total_mb || gpu.memory_total_mb))}
        ${metric("温度", suffix(latest.temperature_c, "°C"))}
        ${metric("功耗", powerText(latest.power_usage_w, latest.power_limit_w))}
        ${metric("更新时间", timeText(latest.timestamp))}
      </div>
      <div class="chart-wrap">
        <canvas id="chart-${gpu.index}" width="760" height="300" aria-label="GPU ${gpu.index} 利用率曲线"></canvas>
      </div>
    </article>
  `;
}

function metric(label, value) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

async function refreshCharts() {
  await Promise.all(
    state.gpus.map(async (gpu) => {
      const minutes = Number(els.historyWindow.value);
      const end = new Date();
      const start = new Date(end.getTime() - minutes * 60 * 1000);
      const params = new URLSearchParams({
        gpu: String(gpu.index),
        from: start.toISOString(),
        to: end.toISOString(),
        limit: "2000",
      });
      const data = await fetchJson(`/api/metrics/history?${params}`);
      if (data.collector_error) {
        els.status.innerHTML = `<span class="error">${escapeHtml(data.collector_error)}</span>`;
      }
      drawChart(state.charts.get(gpu.index), data.metrics || []);
    }),
  );
}

function drawChart(canvas, metrics) {
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const padding = { top: 20, right: 48, bottom: 34, left: 42 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx, width, height, padding, plotWidth, plotHeight);

  if (!metrics.length) {
    ctx.fillStyle = colors.muted;
    ctx.font = "14px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("等待采样数据", width / 2, height / 2);
    return;
  }

  drawSeries(ctx, metrics, "gpu_utilization", colors.gpu, padding, plotWidth, plotHeight);
  drawSeries(ctx, metrics, "memory_utilization", colors.memory, padding, plotWidth, plotHeight);
  drawLegend(ctx, padding);
}

function drawGrid(ctx, width, height, padding, plotWidth, plotHeight) {
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.font = "12px system-ui";
  ctx.fillStyle = colors.muted;
  ctx.textAlign = "right";

  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotHeight * i) / 4;
    const value = 100 - i * 25;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(`${value}%`, padding.left - 8, y + 4);
  }

  ctx.strokeStyle = colors.text;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();
}

function drawSeries(ctx, metrics, key, color, padding, plotWidth, plotHeight) {
  const firstTime = new Date(metrics[0].timestamp).getTime();
  const lastTime = new Date(metrics[metrics.length - 1].timestamp).getTime();
  const range = Math.max(lastTime - firstTime, 1);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();

  metrics.forEach((metricRow, index) => {
    const x =
      padding.left + ((new Date(metricRow.timestamp).getTime() - firstTime) / range) * plotWidth;
    const y = padding.top + (1 - clamp(Number(metricRow[key] || 0) / 100, 0, 1)) * plotHeight;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();

  if (metrics.length === 1) {
    const value = Number(metrics[0][key] || 0);
    const y = padding.top + (1 - clamp(value / 100, 0, 1)) * plotHeight;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(padding.left + plotWidth / 2, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLegend(ctx, padding) {
  const items = [
    ["GPU", colors.gpu],
    ["显存", colors.memory],
  ];
  ctx.font = "12px system-ui";
  ctx.textAlign = "left";
  items.forEach(([label, color], index) => {
    const x = padding.left + index * 76;
    ctx.fillStyle = color;
    ctx.fillRect(x, 10, 18, 4);
    ctx.fillStyle = colors.text;
    ctx.fillText(label, x + 24, 15);
  });
}

function renderStatsGpuOptions() {
  const current = els.statsGpu.value;
  els.statsGpu.innerHTML = state.gpus
    .map((gpu) => `<option value="${gpu.index}">GPU ${gpu.index} - ${escapeHtml(gpu.name)}</option>`)
    .join("");
  if (current && state.gpus.some((gpu) => String(gpu.index) === current)) {
    els.statsGpu.value = current;
  }
}

async function loadStats() {
  if (!els.statsGpu.value) {
    els.statsResult.innerHTML = `<div class="empty">没有可统计的 GPU</div>`;
    return;
  }

  const params = new URLSearchParams({
    gpu: els.statsGpu.value,
    from: new Date(els.statsFrom.value).toISOString(),
    to: new Date(els.statsTo.value).toISOString(),
  });
  const data = await fetchJson(`/api/stats?${params}`);
  const stats = data.stats || {};
  els.statsResult.innerHTML = [
    stat("样本数", number(stats.samples, 0)),
    stat("平均 GPU", percent(stats.avg_gpu_utilization)),
    stat("最高 GPU", percent(stats.max_gpu_utilization)),
    stat("平均显存", percent(stats.avg_memory_utilization)),
    stat("最高显存", percent(stats.max_memory_utilization)),
    stat("平均显存用量", suffix(stats.avg_memory_used_mb, " MB")),
    stat("最高显存用量", suffix(stats.max_memory_used_mb, " MB")),
    stat("平均温度", suffix(stats.avg_temperature_c, "°C")),
    stat("最高温度", suffix(stats.max_temperature_c, "°C")),
    stat("平均功耗", suffix(stats.avg_power_usage_w, " W")),
    stat("最高功耗", suffix(stats.max_power_usage_w, " W")),
  ].join("");
}

function stat(label, value) {
  return `<div class="stat-cell"><span>${label}</span><strong>${value}</strong></div>`;
}

function setDefaultStatsRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  els.statsFrom.value = toDatetimeLocal(start);
  els.statsTo.value = toDatetimeLocal(end);
}

function toDatetimeLocal(date) {
  const offset = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function percent(value) {
  return value === null || value === undefined ? "-" : `${Number(value).toFixed(0)}%`;
}

function suffix(value, unit) {
  return value === null || value === undefined ? "-" : `${Number(value).toFixed(1)}${unit}`;
}

function number(value, digits) {
  return value === null || value === undefined ? "-" : Number(value).toFixed(digits);
}

function memoryText(used, total) {
  if (used === null || used === undefined || total === null || total === undefined) return "-";
  return `${Number(used).toFixed(0)} / ${Number(total).toFixed(0)} MB`;
}

function powerText(used, limit) {
  if (used === null || used === undefined) return "-";
  if (limit === null || limit === undefined) return `${Number(used).toFixed(1)} W`;
  return `${Number(used).toFixed(1)} / ${Number(limit).toFixed(1)} W`;
}

function timeText(value) {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[char];
  });
}
