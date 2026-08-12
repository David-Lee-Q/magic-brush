(function () {
  "use strict";

  var LS_SETTINGS = "mb.settings";
  var LS_HISTORY = "mb.history";
  var MAX_HISTORY = 50;

  var DEFAULT_SETTINGS = {
    datasource: "builtin",
    baseURL: "",
    apiKey: "",
    model: "gpt-image-1",
    defaultSize: "1024x1024"
  };

  var PRESET_SIZES = [
    "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792",
    "512x512", "256x256",
    "1920x1080", "1280x720", "1280x800", "1024x768",
    "720x1280", "720x1560", "768x1024"
  ];

  var BUILTIN_SIZES = ["256x256", "512x512", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792"];

  var state = {
    mode: "text2img",
    refDataUrl: null,
    generating: false,
    lastImages: [],
    lightboxUrl: null,
    lightboxImages: [],
    lightboxIndex: 0,
    lightboxScale: 1
  };

  var $ = function (id) { return document.getElementById(id); };

  function loadSettings() {
    try {
      var raw = localStorage.getItem(LS_SETTINGS);
      if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return Object.assign({}, DEFAULT_SETTINGS);
  }

  function saveSettings(s) {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
  }

  function loadHistory() {
    try {
      var raw = localStorage.getItem(LS_HISTORY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.records)) return parsed.records;
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function saveHistory(records) {
    try {
      localStorage.setItem(LS_HISTORY, JSON.stringify({ records: records }));
    } catch (e) {
      records.shift();
      try {
        localStorage.setItem(LS_HISTORY, JSON.stringify({ records: records }));
      } catch (e2) { /* ignore */ }
    }
  }

  function normalizeSettings() {
    var s = loadSettings();
    s.baseURL = (s.baseURL || "").trim().replace(/\/+$/, "");
    s.apiKey = (s.apiKey || "").trim();
    s.model = (s.model || "").trim();
    return s;
  }

  function refreshCfgStatus() {
    var s = loadSettings();
    var el = $("cfg-status");
    if (s.datasource === "builtin") {
      el.textContent = "已配置：内置服务";
      el.classList.add("ok");
    } else if (s.baseURL && s.apiKey) {
      el.textContent = "已配置：" + s.model;
      el.classList.add("ok");
    } else {
      el.textContent = "未配置";
      el.classList.remove("ok");
    }
    syncModeAvailability();
  }

  function syncModeAvailability() {
    var s = loadSettings();
    var builtin = s.datasource !== "custom";
    document.querySelectorAll(".mode-tab").forEach(function (tab) {
      var dis = builtin && tab.dataset.mode === "img2img";
      tab.disabled = false;
      tab.setAttribute("aria-disabled", String(dis));
      tab.classList.toggle("is-disabled", dis);
    });
    if (builtin && state.mode === "img2img") setMode("text2img");
  }

  function showError(msg) {
    var box = $("error-box");
    box.textContent = msg;
    box.classList.remove("hidden");
  }

  function clearError() {
    $("error-box").classList.add("hidden");
  }

  function showToast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      t.classList.add("hidden");
    }, 3000);
  }

  function uniqueId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  function pollJob(jobId) {
    var attempts = 0;
    var maxAttempts = 150;
    function tick() {
      return fetch("/api/status/" + jobId).then(function (resp) {
        return resp.json().catch(function () { return {}; });
      }).then(function (body) {
        if (body.status === "done") {
          return { images: body.images || [] };
        }
        if (body.status === "error") {
          throw new Error(body.error || "图片生成失败，请重试");
        }
        if (attempts++ >= maxAttempts) {
          throw new Error("生成超时，请稍后重试");
        }
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            tick().then(resolve, reject);
          }, 2000);
        });
      });
    }
    return tick();
  }

  function generateJob(payload) {
    return fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (body) {
        if (!resp.ok || !body.jobId) {
          throw new Error((body && body.error) || "生成请求失败（HTTP " + resp.status + "）");
        }
        return pollJob(body.jobId);
      });
    });
  }

  function toImageObjects(srcList) {
    return (srcList || []).map(function (src) {
      return { src: src, b64: true };
    });
  }

  function downloadDataUrl(dataUrl, filename) {
    var a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function downloadByUrl(url, filename) {
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function handleDownload(image, filename) {
    if (image.b64) {
      downloadDataUrl(image.src, filename);
      return;
    }
    fetch(image.src).then(function (resp) {
      if (!resp.ok) throw new Error();
      return resp.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      downloadByUrl(url, filename);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }).catch(function () {
      downloadByUrl(image.src, filename);
    });
  }

  function renderImages(images) {
    var grid = $("result-grid");
    grid.innerHTML = "";
    images = (images || []).map(function (item) {
      if (typeof item === "string") return { src: item, b64: true };
      return item;
    });
    state.lastImages = images;

    if (!images.length) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<p>未返回任何图片，请检查接口响应格式</p>";
      grid.appendChild(empty);
      return;
    }

    images.forEach(function (img, idx) {
      var card = document.createElement("figure");
      card.className = "image-card";
      card.setAttribute("data-idx", String(idx));

      var im = document.createElement("img");
      im.alt = "生成图片 " + (idx + 1);
      im.loading = "lazy";
      card.appendChild(im);

      var actions = document.createElement("div");
      actions.className = "image-actions";
      var dl = document.createElement("button");
      dl.type = "button";
      dl.className = "btn";
      dl.textContent = "下载";
      dl.addEventListener("click", function (e) {
        e.stopPropagation();
        handleDownload(img, "shenbi-" + idx + "-" + Date.now() + ".png");
      });
      actions.appendChild(dl);
      card.appendChild(actions);

      card.addEventListener("click", function () {
        openLightbox(img, idx, state.lastImages);
      });

      grid.appendChild(card);

      im.onload = function () {
        card.classList.remove("loading-mask");
      };
      im.onerror = function () {
        card.classList.remove("loading-mask");
        im.style.display = "none";
      };
      if (img.b64) {
        im.src = img.src;
        if (im.complete && im.naturalWidth > 0) card.classList.remove("loading-mask");
      } else {
        im.src = img.src;
        im.crossOrigin = "anonymous";
        if (im.complete && im.naturalWidth > 0) card.classList.remove("loading-mask");
      }
    });
  }

  function renderLoading(n) {
    var grid = $("result-grid");
    grid.innerHTML = "";
    $("result-meta").textContent = "";
    var scene = document.createElement("div");
    scene.className = "ink-loading";
    scene.innerHTML =
      '<svg class="ink-loading-svg" viewBox="0 0 320 180" aria-hidden="true">' +
      '<path class="ink-trail" pathLength="1" d="M26 132 C 62 50, 120 160, 174 84 S 268 124, 296 58"/>' +
      '<use class="ink-pen" href="#icon-pen" width="44" height="44" x="-22" y="-22"/>' +
      "</svg>" +
      '<p class="ink-loading-text">神笔作画中，请稍候……</p>';
    grid.appendChild(scene);
  }

  function openLightbox(image, idx, images) {
    var list = (images && images.length) ? images : [image];
    state.lightboxImages = list;
    state.lightboxIndex = Math.min(Math.max(idx || 0, 0), list.length - 1);
    state.lightboxScale = 1;
    state.lightboxUrl = image && image.src ? image.src : "";
    updateLightbox();
    $("lightbox").classList.remove("hidden");
  }

  function toImageObject(item) {
    if (typeof item === "string") return { src: item, b64: true };
    return item;
  }

  function updateLightbox() {
    var list = state.lightboxImages;
    var i = state.lightboxIndex;
    var current = toImageObject(list[i] || list[0]);
    var img = $("lightbox-img");
    var vp = $("lightbox-viewport");
    vp.style.width = "";
    vp.style.height = "";
    img.style.width = "";
    img.onload = applyLightboxScale;
    img.src = current.src;
    state.lightboxUrl = current.src;
    applyLightboxScale();
    var dl = $("lightbox-download");
    dl.onclick = function () {
      handleDownload(current, "shenbi-" + i + "-" + Date.now() + ".png");
    };
    var multi = list.length > 1;
    $("btn-prev-lightbox").classList.toggle("hidden-nav", !multi);
    $("btn-next-lightbox").classList.toggle("hidden-nav", !multi);
    $("lightbox-counter").textContent = multi ? (i + 1) + " / " + list.length : "";
  }

  function applyLightboxScale() {
    var s = state.lightboxScale || 1;
    $("lightbox-scale").textContent = Math.round(s * 100) + "%";
    var img = $("lightbox-img");
    if (!img.naturalWidth || !img.naturalHeight) return;
    var vp = $("lightbox-viewport");
    var cs = getComputedStyle(vp);
    var maxW = parseFloat(cs.maxWidth) || window.innerWidth;
    var maxH = parseFloat(cs.maxHeight) || window.innerHeight;
    var fit = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    var w = img.naturalWidth * fit * s;
    var h = img.naturalHeight * fit * s;
    var ratio = Math.min(1, maxW / w, maxH / h);
    w *= ratio;
    h *= ratio;
    vp.style.width = Math.round(w) + "px";
    vp.style.height = Math.round(h) + "px";
    img.style.width = "100%";
    img.style.height = "100%";
  }

  function lightboxPrev() {
    if (!state.lightboxImages || state.lightboxImages.length < 2) return;
    state.lightboxIndex = (state.lightboxIndex + state.lightboxImages.length - 1) % state.lightboxImages.length;
    updateLightbox();
  }

  function lightboxNext() {
    if (!state.lightboxImages || state.lightboxImages.length < 2) return;
    state.lightboxIndex = (state.lightboxIndex + 1) % state.lightboxImages.length;
    updateLightbox();
  }

  function lightboxZoom(delta) {
    state.lightboxScale = Math.min(4, Math.max(0.5, (state.lightboxScale || 1) + delta));
    applyLightboxScale();
  }

  function resetLightboxScale() {
    state.lightboxScale = 1;
    applyLightboxScale();
  }

  function closeLightbox() {
    $("lightbox").classList.add("hidden");
    $("lightbox-img").src = "";
    $("lightbox-counter").textContent = "";
    state.lightboxUrl = null;
    state.lightboxImages = [];
    state.lightboxScale = 1;
  }

  function addHistory(record) {
    var records = loadHistory();
    records.unshift(record);
    while (records.length > MAX_HISTORY) records.pop();
    saveHistory(records);
    renderHistory();
  }

  function clearHistory() {
    saveHistory([]);
    try { localStorage.setItem("mb.historySeeded", "1"); } catch (e) { /* ignore */ }
    renderHistory();
  }

  function removeHistory(id) {
    saveHistory(loadHistory().filter(function (r) { return r.id !== id; }));
    renderHistory();
  }

  function makeMockImage(kind) {
    var canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    var ctx = canvas.getContext("2d");
    if (kind === "ink") {
      var g1 = ctx.createLinearGradient(0, 0, 256, 256);
      g1.addColorStop(0, "#f5efe0");
      g1.addColorStop(1, "#d8cbb0");
      ctx.fillStyle = g1;
      ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = "rgba(60,60,60,.6)";
      ctx.beginPath();
      ctx.moveTo(0, 210);
      ctx.quadraticCurveTo(64, 150, 128, 200);
      ctx.quadraticCurveTo(200, 150, 256, 210);
      ctx.lineTo(256, 256);
      ctx.lineTo(0, 256);
      ctx.fill();
      ctx.fillStyle = "#e8b24a";
      ctx.beginPath();
      ctx.arc(192, 70, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(60, 180);
      ctx.quadraticCurveTo(100, 150, 140, 170);
      ctx.quadraticCurveTo(120, 130, 150, 115);
      ctx.stroke();
    } else {
      var g2 = ctx.createLinearGradient(0, 0, 256, 256);
      g2.addColorStop(0, "#1a1a3a");
      g2.addColorStop(1, "#3a1060");
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = "#12062a";
      ctx.fillRect(16, 150, 42, 106);
      ctx.fillRect(66, 128, 52, 128);
      ctx.fillRect(126, 158, 62, 98);
      ctx.fillRect(196, 138, 44, 118);
      ctx.fillStyle = "#00e5ff";
      ctx.fillRect(74, 134, 9, 9);
      ctx.fillRect(92, 150, 9, 9);
      ctx.fillStyle = "#ff2d78";
      ctx.fillRect(134, 166, 9, 9);
      ctx.fillRect(152, 156, 9, 9);
      ctx.fillStyle = "#ffe600";
      ctx.fillRect(204, 146, 7, 7);
      ctx.fillRect(220, 160, 7, 7);
    }
    return canvas.toDataURL("image/png");
  }

  function makeMockRecords() {
    return [
      {
        id: "mock-ink",
        prompt: "一只在月光下展翅的仙鹤，仙气飘飘",
        size: "512x512",
        style: "水墨风",
        count: 1,
        ts: Date.now() - 3600000,
        mode: "text2img",
        images: [makeMockImage("ink")]
      },
      {
        id: "mock-cyber",
        prompt: "赛博朋克城市夜景，霓虹闪烁",
        size: "1024x1024",
        style: "赛博朋克",
        count: 1,
        ts: Date.now() - 7200000,
        mode: "text2img",
        images: [makeMockImage("cyber")]
      }
    ];
  }

  function seedMockHistory() {
    try {
      if (localStorage.getItem("mb.historySeeded")) return;
      var existing = loadHistory();
      if (!existing.length) {
        saveHistory(makeMockRecords());
      } else if (existing.every(function (r) { return String(r.id || "").indexOf("mock-") === 0; })) {
        saveHistory(makeMockRecords());
      }
      localStorage.setItem("mb.historySeeded", "1");
    } catch (e) { /* ignore */ }
  }

  function formatTime(ts) {
    var d = new Date(ts);
    function p(v) { return v < 10 ? "0" + v : String(v); }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
      p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function styleLabel(key) {
    if (!key) return "";
    var opt = $("style").querySelector('option[value="' + key + '"]');
    return opt ? opt.textContent : key;
  }

  function renderHistory() {
    var listEl = $("history-list");
    var records = loadHistory();
    listEl.innerHTML = "";
    if (!records.length) {
      var empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "暂无记录";
      listEl.appendChild(empty);
      return;
    }
    records.forEach(function (rec) {
      var item = document.createElement("div");
      item.className = "history-item";

      var del = document.createElement("button");
      del.className = "history-item-del";
      del.title = "删除该记录";
      del.setAttribute("aria-label", "删除该记录");
      del.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
        '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' +
        "</svg>";
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        removeHistory(rec.id);
      });

      var info = document.createElement("div");
      info.className = "history-item-info";
      var p = document.createElement("div");
      p.className = "history-item-prompt";
      p.textContent = rec.prompt || "(无提示词)";
      p.title = rec.prompt || "";
      var meta = document.createElement("div");
      meta.className = "history-item-meta";
      var badge = document.createElement("span");
      badge.className = "history-badge" + (rec.mode === "img2img" ? " history-badge-img" : " history-badge-text");
      badge.textContent = rec.mode === "img2img" ? "图生图" : "文生图";
      var metaText = document.createElement("span");
      metaText.className = "history-item-time";
      var sizeText = (rec.params && rec.params.size) || rec.size || "";
      var styleText = styleLabel((rec.params && rec.params.style) || rec.style || "");
      var metaParts = [formatTime(rec.ts)];
      if (sizeText) metaParts.push(sizeText);
      if (styleText) metaParts.push(styleText);
      metaText.textContent = metaParts.join(" · ");
      meta.appendChild(badge);
      meta.appendChild(metaText);
      info.appendChild(p);
      info.appendChild(meta);

      var thumbs = document.createElement("div");
      thumbs.className = "history-thumbs";
      (rec.images || []).slice(0, 4).forEach(function (src, i) {
        var im = document.createElement("img");
        im.src = src;
        im.alt = "缩略图";
        im.addEventListener("click", function (e) {
          e.stopPropagation();
          openLightbox({ src: src, b64: true }, i, rec.images);
        });
        thumbs.appendChild(im);
      });

      item.appendChild(info);
      item.appendChild(thumbs);
      item.appendChild(del);
      item.addEventListener("click", function () {
        document.querySelectorAll(".history-item").forEach(function (el) {
          el.classList.remove("active");
        });
        item.classList.add("active");
        $("result-title").textContent = "历史结果";
        renderImages(rec.images || []);
        $("result-meta").textContent = rec.prompt || "";
      });
      listEl.appendChild(item);
    });
  }

  function validateSettings() {
    var s = normalizeSettings();
    if (s.datasource === "custom" && (!s.baseURL || !s.apiKey)) {
      showError("自定义 API 模式需要填写 API 基础地址与 API Key：点击右上角「设置」。");
      openSettings();
      return null;
    }
    return s;
  }

  function getSize() {
    var v = $("size").value;
    if (v !== "custom") return v;
    var w = parseInt($("size-cw").value, 10);
    var h = parseInt($("size-ch").value, 10);
    if (!w || !h || w < 64 || h < 64 || w > 2048 || h > 2048) return null;
    return w + "x" + h;
  }

  function syncSizeCustom() {
    $("size-custom").classList.toggle("hidden", $("size").value !== "custom");
  }

  function initSizeFromSettings() {
    var d = loadSettings().defaultSize || "1024x1024";
    var sel = $("size");
    if (PRESET_SIZES.indexOf(d) !== -1) {
      sel.value = d;
    } else {
      var m = /^(\d{2,4})x(\d{2,4})$/i.exec(d);
      if (m) {
        sel.value = "custom";
        $("size-cw").value = parseInt(m[1], 10);
        $("size-ch").value = parseInt(m[2], 10);
      } else {
        sel.value = "1024x1024";
      }
    }
    syncSizeCustom();
  }

  function doGenerate() {
    if (state.generating) return;
    clearError();

    var prompt = $("prompt").value.trim();
    if (!prompt) {
      showError("请先输入提示词，描述你想要生成的画面。");
      return;
    }

    var s = validateSettings();
    if (!s) return;

    var n = parseInt($("count").value, 10) || 1;
    var size = getSize();
    if (!size) {
      showError("请输入自定义尺寸：宽和高需在 64-2048 之间。");
      return;
    }
    var style = $("style").value;

    if (s.defaultSize !== size) {
      s.defaultSize = size;
      saveSettings(s);
    }

    var refFile = $("ref-input").files && $("ref-input").files[0];
    var mode = state.mode;
    if (mode === "img2img" && !state.refDataUrl) {
      showError("图生图模式需要先上传参考图片。");
      return;
    }

    var isBuiltin = s.datasource !== "custom";
    if (mode === "img2img" && isBuiltin) {
      showError("内置服务暂不支持图生图，请在设置中切换「自定义 API」模式。");
      return;
    }
    if (isBuiltin && BUILTIN_SIZES.indexOf(size) === -1) {
      showToast("内置服务仅支持固定尺寸，将自动匹配最接近的尺寸");
    }

    state.generating = true;
    $("btn-generate").disabled = true;
    $("btn-generate-label").textContent = "生成中…";
    renderLoading(n);
    $("result-title").textContent = "生成结果";
    $("result-meta").textContent = "提示词：" + prompt + " · " + size + " · " + n + " 张";
    if (!isBuiltin) {
      showToast("自定义模型生成较慢，预计 1-3 分钟，请耐心等待");
    }

    var startedAt = Date.now();
    state.elapsedTimer = setInterval(function () {
      var sec = Math.round((Date.now() - startedAt) / 1000);
      $("result-meta").textContent = "生成中，已耗时 " + sec + " 秒…";
    }, 1000);

    var promise;
    var payload = { prompt: prompt, n: n, size: size, style: style };
    if (isBuiltin) {
      payload.source = "builtin";
    } else {
      payload.source = "custom";
      payload.baseURL = s.baseURL;
      payload.apiKey = s.apiKey;
      payload.model = s.model;
      if (mode === "img2img" && state.refDataUrl) {
        payload.imageDataUrl = state.refDataUrl;
      }
    }
    promise = generateJob(payload);

    promise.then(function (body) {
      var images = toImageObjects(body.images);
      renderImages(images);
      var record = {
        id: uniqueId(),
        ts: Date.now(),
        prompt: prompt,
        mode: mode,
        params: { model: s.model, n: n, size: size, style: style },
        images: images.map(function (img) {
          return img.src;
        })
      };
      addHistory(record);
      if (!images.length) {
        showError("图片服务返回成功但未解析到图片，请稍后重试。");
      }
    }).catch(function (err) {
      $("result-grid").innerHTML = "";
      $("result-meta").textContent = "";
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<p>生成失败</p>";
      $("result-grid").appendChild(empty);

      var msg = err && err.message ? err.message : "请求失败，请检查网络或接口配置。";
      if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
        msg += "\n可能原因：接口地址无法访问，或目标服务不允许跨域请求（CORS）。" +
          "\n建议：确认接口地址正确、网络可达；若为 CORS 拦截，请在服务端开启跨域，或经支持跨域的反向代理转发。";
      }
      showError(msg);
    }).finally(function () {
      state.generating = false;
      if (state.elapsedTimer) {
        clearInterval(state.elapsedTimer);
        state.elapsedTimer = null;
      }
      $("btn-generate").disabled = false;
      $("btn-generate-label").textContent = "开始生成";
    });
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll(".mode-tab").forEach(function (tab) {
      tab.classList.toggle("active", tab.dataset.mode === mode);
    });
    var refWrap = $("ref-image-wrap");
    refWrap.classList.toggle("hidden", mode !== "img2img");
    if (mode === "text2img") {
      $("ref-input").value = "";
      $("btn-upload-ref").classList.remove("hidden");
      $("ref-preview").classList.add("hidden");
      state.refDataUrl = null;
    }
  }

  function openSettings() {
    var s = loadSettings();
    $("cfg-datasource").value = s.datasource || "builtin";
    $("cfg-baseurl").value = s.baseURL;
    $("cfg-apikey").value = s.apiKey;
    $("cfg-model").value = s.model;
    var builtin = s.datasource !== "custom";
    ["cfg-baseurl", "cfg-apikey", "cfg-model"].forEach(function (id) {
      $(id).disabled = builtin;
    });
    $("settings-modal").classList.remove("hidden");
  }

  function closeSettings() {
    $("settings-modal").classList.add("hidden");
  }

  function openVersionModal() {
    $("version-modal").classList.remove("hidden");
  }

  function closeVersionModal() {
    $("version-modal").classList.add("hidden");
  }

  function openDebugModal() {
    var baseURL = $("cfg-baseurl").value.trim();
    var apiKey = $("cfg-apikey").value.trim();
    var model = $("cfg-model").value.trim() || DEFAULT_SETTINGS.model;
    if (!baseURL) {
      showToast("请先在设置中填写 API 基础地址");
      return;
    }
    $("debug-cfg-line").textContent = "地址: " + baseURL + " ｜ 模型: " + model;
    $("debug-result").innerHTML = "";
    $("debug-modal").classList.remove("hidden");
  }

  function closeDebugModal() {
    $("debug-modal").classList.add("hidden");
  }

  function badge(ok) {
    return '<span class="debug-badge ' + (ok ? "ok" : "err") + '">' + (ok ? "成功" : "失败") + "</span>";
  }

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderDebugResult(data) {
    var html = "";
    html += '<div class="debug-block"><div class="debug-block-title">连接信息</div>' +
      '<div class="debug-row"><span>归一化地址</span><code>' + escHtml(data.base) + "</code></div>" +
      '<div class="debug-row"><span>模型名称</span><code>' + escHtml(data.model) + "</code></div></div>";

    var m = data.models;
    html += '<div class="debug-block"><div class="debug-block-title">模型列表 <span class="debug-dim">GET ' + escHtml(data.base) + '/models</span></div>' +
      '<div class="debug-row"><span>结果</span>' + badge(!!(m && m.ok)) + '</div>' +
      '<div class="debug-row"><span>状态码</span><code>' + (m ? m.status : "—") + "</code></div>" +
      '<div class="debug-row"><span>耗时</span><code>' + (m ? m.timeMs + "ms" : "—") + "</code></div>";
    if (m && m.ok && m.ids.length) {
      html += '<div class="debug-row"><span>可用模型</span><select id="debug-model-select" class="debug-model-select">' +
        m.ids.map(function (id) { return "<option value=\"" + escHtml(id) + "\">" + escHtml(id) + "</option>"; }).join("") +
        '</select></div>';
    } else if (m && m.error) {
      html += '<div class="debug-row"><span>错误</span><code class="debug-err">' + escHtml(m.error) + "</code></div>";
    }
    html += "</div>";

    var g = data.generate;
    html += '<div class="debug-block"><div class="debug-block-title">生成请求 <span class="debug-dim">POST ' + escHtml(data.base) + '/images/generations</span></div>' +
      '<div class="debug-row"><span>结果</span>' + badge(!!(g && g.ok)) + '</div>' +
      '<div class="debug-row"><span>状态码</span><code>' + (g ? g.status : "—") + "</code></div>" +
      '<div class="debug-row"><span>耗时</span><code>' + (g ? g.timeMs + "ms" : "—") + "</code></div>" +
      '<div class="debug-row"><span>返回图片数</span><code>' + (g ? g.imageCount : "—") + "</code></div>";
    if (g && g.error) {
      html += '<div class="debug-row"><span>错误</span><code class="debug-err">' + escHtml(g.error) + "</code></div>";
    }
    html += '<div class="debug-row"><span>响应体</span></div>' +
      '<pre class="debug-pre">' + escHtml(g && g.body ? g.body : "(无响应体)") + "</pre></div>";

    return html;
  }

  function renderDebugError(msg) {
    return '<div class="debug-block"><div class="debug-block-title">调试失败</div>' +
      '<div class="debug-row"><span>错误</span><code class="debug-err">' + escHtml(msg) + "</code></div></div>";
  }

  function runDebug() {
    var cfg = {
      baseURL: $("cfg-baseurl").value.trim(),
      apiKey: $("cfg-apikey").value.trim(),
      model: $("cfg-model").value.trim() || DEFAULT_SETTINGS.model
    };
    if (!cfg.baseURL) {
      showToast("请先填写 API 基础地址");
      return;
    }
    var resultEl = $("debug-result");
    resultEl.innerHTML = '<div class="debug-loading">正在测试…（模型列表超时 15s，生成请求超时 20s）</div>';
    $("btn-run-debug").disabled = true;
    fetch("/api/debug/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg)
    }).then(function (resp) {
      return resp.json().catch(function () { return {}; });
    }).then(function (body) {
      if (!body.ok || !body.data) {
        resultEl.innerHTML = renderDebugError(body.error || "调试请求失败");
        return;
      }
      resultEl.innerHTML = renderDebugResult(body.data);
      var sel = $("debug-model-select");
      if (sel) {
        sel.addEventListener("change", function () {
          $("cfg-model").value = sel.value;
        });
      }
    }).catch(function (e) {
      resultEl.innerHTML = renderDebugError(e && e.message ? e.message : "调试请求失败");
    }).finally(function () {
      $("btn-run-debug").disabled = false;
    });
  }

  function saveSettingsFromUI() {
    var s = loadSettings();
    s.datasource = $("cfg-datasource").value || "builtin";
    s.baseURL = $("cfg-baseurl").value.trim();
    s.apiKey = $("cfg-apikey").value.trim();
    s.model = $("cfg-model").value.trim() || DEFAULT_SETTINGS.model;
    if (s.datasource === "custom" && !s.baseURL) {
      showToast("自定义 API 模式请填写 API 基础地址");
      return;
    }
    saveSettings(s);
    closeSettings();
    refreshCfgStatus();
    clearError();
    showToast("配置已保存");
  }

  function bindEvents() {
    document.querySelectorAll(".mode-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        if (tab.classList.contains("is-disabled")) {
          showToast("内置服务暂不支持图生图，请在设置中切换「自定义 API」模式");
          return;
        }
        setMode(tab.dataset.mode);
      });
    });

    $("btn-generate").addEventListener("click", doGenerate);

    $("size").addEventListener("change", syncSizeCustom);

    $("btn-upload-ref").addEventListener("click", function () {
      $("ref-input").click();
    });

    $("ref-input").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        showError("请上传图片格式的文件。");
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        showError("参考图片不能超过 10MB。");
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        state.refDataUrl = reader.result;
        $("ref-img").src = reader.result;
        $("btn-upload-ref").classList.add("hidden");
        $("ref-preview").classList.remove("hidden");
        clearError();
      };
      reader.onerror = function () {
        showError("读取参考图片失败，请重试。");
      };
      reader.readAsDataURL(file);
    });

    $("btn-remove-ref").addEventListener("click", function () {
      $("ref-input").value = "";
      state.refDataUrl = null;
      $("btn-upload-ref").classList.remove("hidden");
      $("ref-preview").classList.add("hidden");
      $("ref-img").src = "";
    });

    $("btn-settings").addEventListener("click", openSettings);
    $("btn-close-settings").addEventListener("click", closeSettings);
    $("btn-version").addEventListener("click", openVersionModal);
    $("btn-close-version").addEventListener("click", closeVersionModal);
    $("btn-version-ok").addEventListener("click", closeVersionModal);
    $("version-modal").addEventListener("click", function (e) {
      if (e.target === $("version-modal")) closeVersionModal();
    });
    $("btn-save-settings").addEventListener("click", saveSettingsFromUI);
    $("btn-debug-model").addEventListener("click", openDebugModal);
    $("btn-close-debug").addEventListener("click", closeDebugModal);
    $("btn-run-debug").addEventListener("click", runDebug);
    $("debug-modal").addEventListener("click", function (e) {
      if (e.target === $("debug-modal")) closeDebugModal();
    });

    $("cfg-datasource").addEventListener("change", syncDatasourceFields);

    function syncDatasourceFields() {
      var builtin = $("cfg-datasource").value !== "custom";
      ["cfg-baseurl", "cfg-apikey", "cfg-model"].forEach(function (id) {
        $(id).disabled = builtin;
      });
    }

    $("btn-clear-history").addEventListener("click", function () {
      if (loadHistory().length && window.confirm("确定清空全部历史记录？")) {
        clearHistory();
        showToast("历史记录已清空");
      }
    });

    $("btn-close-lightbox").addEventListener("click", closeLightbox);
    $("lightbox").addEventListener("click", function (e) {
      if (e.target === $("lightbox")) closeLightbox();
    });

    $("btn-prev-lightbox").addEventListener("click", lightboxPrev);
    $("btn-next-lightbox").addEventListener("click", lightboxNext);
    $("btn-zoom-in").addEventListener("click", function () { lightboxZoom(0.25); });
    $("btn-zoom-out").addEventListener("click", function () { lightboxZoom(-0.25); });
    $("btn-zoom-reset").addEventListener("click", resetLightboxScale);

    var vp = $("lightbox-viewport");
    vp.addEventListener("wheel", function (e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        lightboxZoom(e.deltaY < 0 ? 0.25 : -0.25);
      }
    }, { passive: false });

    (function bindDrag() {
      var down = false, sx = 0, sy = 0, sl = 0, st = 0;
      vp.addEventListener("mousedown", function (e) {
        if (e.target !== $("lightbox-img")) return;
        down = true;
        vp.classList.add("dragging");
        sx = e.clientX; sy = e.clientY;
        sl = vp.scrollLeft; st = vp.scrollTop;
      });
      window.addEventListener("mousemove", function (e) {
        if (!down) return;
        vp.scrollLeft = sl - (e.clientX - sx);
        vp.scrollTop = st - (e.clientY - sy);
      });
      window.addEventListener("mouseup", function () {
        down = false;
        vp.classList.remove("dragging");
      });
    })();

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeLightbox();
        closeSettings();
        closeDebugModal();
        return;
      }
      if ($("lightbox").classList.contains("hidden")) return;
      if (e.key === "ArrowLeft") lightboxPrev();
      else if (e.key === "ArrowRight") lightboxNext();
      else if (e.key === "+" || e.key === "=") lightboxZoom(0.25);
      else if (e.key === "-" || e.key === "_") lightboxZoom(-0.25);
      else if (e.key === "0") resetLightboxScale();
    });

    $("prompt").addEventListener("input", function () {
      if ($("prompt").value.trim()) clearError();
    });
  }

  function init() {
    $("prompt-hint").textContent = "支持中文描述，例如：一只飞行的龙，水墨风格，气势磅礴";
    refreshCfgStatus();
    initSizeFromSettings();
    seedMockHistory();
    renderHistory();
    bindEvents();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
