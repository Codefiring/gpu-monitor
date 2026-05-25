const state = {
  gpus: [],
  latestByGpu: new Map(),
  charts: new Map(),
  timer: null,
  activeView: "monitor",
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
  viewCards: Array.from(document.querySelectorAll(".view-card")),
  monitorView: document.getElementById("monitorView"),
  statsView: document.getElementById("statsView"),
  gpuGrid: document.getElementById("gpuGrid"),
  historyControl: document.getElementById("historyControl"),
  historyWindow: document.getElementById("historyWindow"),
  refreshButton: document.getElementById("refreshButton"),
  statsGpu: document.getElementById("statsGpu"),
  statsFrom: document.getElementById("statsFrom"),
  statsTo: document.getElementById("statsTo"),
  statsButton: document.getElementById("statsButton"),
  statsResult: document.getElementById("statsResult"),
  statsChart: document.getElementById("statsChart"),
  statsChartTitle: document.getElementById("statsChartTitle"),
};

document.addEventListener("DOMContentLoaded", async () => {
  setDefaultStatsRange();
  bindViewSwitching();
  await refreshAll();
  state.timer = window.setInterval(refreshAll, 5000);
});

els.refreshButton.addEventListener("click", async () => {
  await refreshAll();
  if (state.activeView === "stats") {
    await loadStats();
  }
});
els.historyWindow.addEventListener("change", refreshAll);
els.statsButton.addEventListener("click", async () => {
  await loadStats();
});

function bindViewSwitching() {
  els.viewCards.forEach((card) => {
    card.addEventListener("click", async () => {
      await switchView(card.dataset.view);
    });
  });
}

async function switchView(view) {
  state.activeView = view;
  els.monitorView.hidden = view !== "monitor";
  els.statsView.hidden = view !== "stats";
  els.historyControl.hidden = view !== "monitor";

  els.viewCards.forEach((card) => {
    const isActive = card.dataset.view === view;
    card.classList.toggle("is-active", isActive);
    card.setAttribute("aria-pressed", String(isActive));
  });

  if (view === "monitor") {
    await refreshCharts();
  } else {
    await loadStats();
  }
}

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
    if (state.activeView === "monitor") {
      await refreshCharts();
    }
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

function historyPointLimit(minutes) {
  const assumedSampleSeconds = 5;
  const expectedPoints = Math.ceil((minutes * 60) / assumedSampleSeconds);
  return Math.min(Math.max(expectedPoints + 24, 120), 10000);
}

async function refreshCharts() {
  if (state.activeView !== "monitor") return;

  await Promise.all(
    state.gpus.map(async (gpu) => {
      const minutes = Number(els.historyWindow.value);
      const end = new Date();
      const start = new Date(end.getTime() - minutes * 60 * 1000);
      const params = new URLSearchParams({
        gpu: String(gpu.index),
        from: toCstOffsetIsoFromDate(start),
        to: toCstOffsetIsoFromDate(end),
        limit: String(historyPointLimit(minutes)),
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

  const chart = prepareCanvas(canvas);
  const ctx = chart.ctx;
  const width = chart.width;
  const height = chart.height;
  const padding = { top: 30, right: 20, bottom: 28, left: 38 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fcfcfd";
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx, width, height, padding, plotWidth, plotHeight, metrics);

  if (!metrics.length) {
    ctx.fillStyle = colors.muted;
    ctx.font = "13px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("该时间段暂无采样数据", width / 2, height / 2);
    return;
  }

  drawSeries(ctx, metrics, "gpu_utilization", colors.gpu, padding, plotWidth, plotHeight, {
    fill: true,
    lineWidth: 2.4,
  });
  drawSeries(ctx, metrics, "memory_utilization", colors.memory, padding, plotWidth, plotHeight, {
    dash: [6, 5],
    lineWidth: 2,
  });
  drawLegend(ctx, padding, metrics);
}

function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(Math.round(rect.width), 320);
  const height = Math.max(Math.round(rect.height), 180);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function drawGrid(ctx, width, height, padding, plotWidth, plotHeight, metrics) {
  ctx.strokeStyle = "#eaecf0";
  ctx.lineWidth = 1;
  ctx.font = "11px system-ui";
  ctx.fillStyle = "#98a2b3";
  ctx.textAlign = "right";

  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotHeight * i) / 4;
    const value = 100 - i * 25;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(`${value}`, padding.left - 8, y + 4);
  }

  ctx.strokeStyle = "#d0d5dd";
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top + plotHeight);
  ctx.lineTo(width - padding.right, padding.top + plotHeight);
  ctx.stroke();

  if (metrics.length >= 2) {
    const first = timestampClock(metrics[0].timestamp);
    const last = timestampClock(metrics[metrics.length - 1].timestamp);
    ctx.fillStyle = "#98a2b3";
    ctx.textAlign = "left";
    ctx.fillText(first, padding.left, height - 8);
    ctx.textAlign = "right";
    ctx.fillText(last, width - padding.right, height - 8);
  }
}

function drawSeries(ctx, metrics, key, color, padding, plotWidth, plotHeight, options = {}) {
  const points = buildPoints(metrics, key, padding, plotWidth, plotHeight);
  if (!points.length) return;

  if (options.fill && points.length > 1) {
    const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotHeight);
    gradient.addColorStop(0, hexToRgba(color, 0.18));
    gradient.addColorStop(1, hexToRgba(color, 0.02));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(points[0].x, padding.top + plotHeight);
    points.forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.lineTo(points[points.length - 1].x, padding.top + plotHeight);
    ctx.closePath();
    ctx.fill();
  }

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = options.lineWidth || 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.setLineDash(options.dash || []);
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      const prev = points[index - 1];
      const midX = (prev.x + point.x) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, midX, (prev.y + point.y) / 2);
      ctx.quadraticCurveTo(midX, (prev.y + point.y) / 2, point.x, point.y);
    }
  });
  ctx.stroke();
  ctx.restore();

  const last = points[points.length - 1];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
  ctx.fill();

  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function buildPoints(metrics, key, padding, plotWidth, plotHeight) {
  const firstTime = new Date(metrics[0].timestamp).getTime();
  const lastTime = new Date(metrics[metrics.length - 1].timestamp).getTime();
  const range = Math.max(lastTime - firstTime, 1);
  return metrics.map((metricRow) => {
    const value = clamp(Number(metricRow[key] || 0), 0, 100);
    const x = padding.left + ((new Date(metricRow.timestamp).getTime() - firstTime) / range) * plotWidth;
    const y = padding.top + (1 - value / 100) * plotHeight;
    return { x, y, value };
  });
}

function drawLegend(ctx, padding, metrics) {
  const latest = metrics[metrics.length - 1] || {};
  const items = [
    ["GPU", colors.gpu, percent(latest.gpu_utilization)],
    ["显存", colors.memory, percent(latest.memory_utilization)],
  ];
  ctx.font = "12px system-ui";
  ctx.textAlign = "left";
  items.forEach(([label, color, value], index) => {
    const x = padding.left + index * 96;
    ctx.fillStyle = color;
    ctx.fillRect(x, 12, 18, 3);
    ctx.fillStyle = colors.text;
    ctx.fillText(`${label} ${value}`, x + 24, 16);
  });
}

function hexToRgba(hex, alpha) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
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
    renderStatsMessage("没有可统计的 GPU");
    drawChart(els.statsChart, []);
    return;
  }

  const startValue = els.statsFrom.value;
  const endValue = els.statsTo.value;
  const start = parseDatetimeLocalAsCst(startValue);
  const end = parseDatetimeLocalAsCst(endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    renderStatsMessage("请选择有效的开始和结束时间");
    drawChart(els.statsChart, []);
    return;
  }

  setStatsLoading(true);
  renderStatsMessage("统计中...");

  const params = new URLSearchParams({
    gpu: els.statsGpu.value,
    from: toCstOffsetIso(startValue),
    to: toCstOffsetIso(endValue),
  });
  const historyParams = new URLSearchParams({
    gpu: els.statsGpu.value,
    from: toCstOffsetIso(startValue),
    to: toCstOffsetIso(endValue),
    limit: "10000",
  });

  try {
    const [statsData, historyData] = await Promise.all([
      fetchJson(`/api/stats?${params}`),
      fetchJson(`/api/metrics/history?${historyParams}`),
    ]);
    const stats = statsData.stats || {};
    const metrics = historyData.metrics || [];
    const selectedGpu = state.gpus.find((gpu) => String(gpu.index) === els.statsGpu.value);
    els.statsChartTitle.textContent = selectedGpu
      ? `GPU ${selectedGpu.index} 时间段曲线 (${formatCstRange(startValue, endValue)})`
      : `时间段曲线 (${formatCstRange(startValue, endValue)})`;
    drawChart(els.statsChart, metrics);
    renderAverageStats(stats);
    els.status.textContent = `统计完成，样本数 ${number(stats.samples, 0)}`;
  } catch (error) {
    renderStatsMessage(`统计失败：${escapeHtml(error.message)}`);
    drawChart(els.statsChart, []);
  } finally {
    setStatsLoading(false);
  }
}

function renderStatsMessage(message) {
  els.statsResult.innerHTML = `<div class="empty stats-message">${message}</div>`;
}

function setStatsLoading(isLoading) {
  els.statsButton.disabled = isLoading;
  els.statsButton.textContent = isLoading ? "统计中" : "统计";
}

function renderAverageStats(stats) {
  els.statsResult.innerHTML = [
    stat("样本数", number(stats.samples, 0)),
    stat("平均 GPU", percent(stats.avg_gpu_utilization)),
    stat("平均显存", percent(stats.avg_memory_utilization)),
    stat("平均显存用量", suffix(stats.avg_memory_used_mb, " MB")),
    stat("平均温度", suffix(stats.avg_temperature_c, "°C")),
    stat("平均功耗", suffix(stats.avg_power_usage_w, " W")),
  ].join("");
}

function stat(label, value) {
  return `<div class="stat-cell"><span>${label}</span><strong>${value}</strong></div>`;
}

function setDefaultStatsRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  els.statsFrom.value = toDatetimeCst(end.getTime() - 60 * 60 * 1000);
  els.statsTo.value = toDatetimeCst(end.getTime());
}

function toDatetimeCst(time) {
  return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function parseDatetimeLocalAsCst(value) {
  return new Date(toCstOffsetIso(value));
}

function toCstOffsetIso(value) {
  return `${value}:00+08:00`;
}

function toCstOffsetIsoFromDate(date) {
  return `${new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19)}+08:00`;
}

function formatCstRange(startValue, endValue) {
  return `${startValue.replace("T", " ")} - ${endValue.replace("T", " ")} CST`;
}

function timestampClock(value) {
  if (!value) return "-";
  const match = String(value).match(/T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?/);
  if (match) return match[1];
  return String(value);
}

function timestampDateTime(value) {
  if (!value) return "-";
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?/);
  if (match) return `${match[1]} ${match[2]}`;
  return String(value);
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
  return timestampClock(value);
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
