const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const fa = new Intl.NumberFormat("fa-IR");
const dates = new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "medium" });
const dateTime = new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "short" });
const NS = "http://www.w3.org/2000/svg";
const results = $("#results");
const drawer = $("#drawer");
const drawerBody = $("#drawer-content");
const searchForm = $("#search-form");
const selected = new Map();
const optionValues = new WeakMap();
let currentPage = "search";
let currentSearch;
let currentMode = "newest";
let cursor;
let searchVersion = 0;
let searchStarted = false;
let drawerVersion = 0;
let toastTimer;
let map;
let mapLayer;
let mapCenter = { lat: 35.704, lon: 51.404 };
let lastMapVersion = 0;

function el(tag, className, ...parts) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...parts.filter(part => part !== null && part !== undefined));
  return element;
}

function icon(name) {
  const svg = document.createElementNS(NS, "svg");
  const use = document.createElementNS(NS, "use");
  use.setAttribute("href", "#" + name);
  svg.setAttribute("aria-hidden", "true");
  svg.append(use);
  return svg;
}

function button(label, glyph, action, variant = "secondary") {
  const control = el("button", "button " + variant, glyph && icon(glyph), label);
  control.type = "button";
  control.addEventListener("click", action);
  return control;
}

function say(text, error = false) {
  const box = $("#toast");
  box.textContent = text;
  box.className = error ? "toast error" : "toast";
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4400);
  if (drawer.open) {
    const status = $("#drawer-status");
    if (status) status.textContent = text;
  }
}

function paintStatus(root, text, kind = "empty") {
  root.replaceChildren(el("p", kind, text));
}

async function api(path, body, options = {}) {
  const settings = { ...options };
  const raw = settings.raw;
  delete settings.raw;
  if (body !== undefined) {
    settings.method ??= "POST";
    settings.headers = { "Content-Type": "application/json", ...settings.headers };
    settings.body = JSON.stringify(body);
  }
  const response = await fetch("/api" + path, settings);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = typeof data.detail === "string" ? data.detail : data.detail?.[0]?.msg;
    throw new Error(detail?.replace(/^Value error, /, "") || "درخواست انجام نشد. دوباره تلاش کن.");
  }
  return raw ? response : response.status === 204 ? null : response.json();
}

function displayDate(value, withTime = false) {
  if (!value) return "هنوز بررسی نشده";
  const date = new Date(value.length === 10 ? value + "T12:00:00+03:30" : value);
  return Number.isNaN(date.getTime()) ? "—" : (withTime ? dateTime : dates).format(date);
}

function numberInput(value) {
  const text = String(value ?? "").trim()
    .replace(/[۰-۹]/g, char => String(char.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, char => String(char.charCodeAt(0) - 1632))
    .replace(/[\s,،٬]/g, "");
  if (!text) return undefined;
  const valueAsNumber = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(valueAsNumber)) {
    throw new Error("در فیلدهای قیمت، سال و کارکرد فقط عدد وارد کن.");
  }
  return valueAsNumber;
}

function formSearch(form) {
  const data = new FormData(form);
  const modelField = form.elements.model_text;
  const text = modelField?.value.trim();
  const model = optionValues.get(modelField)?.get(text);
  const year = numberInput(data.get("year_min"));
  return {
    city: String(data.get("city") || "تهران").trim(),
    model: model || "",
    query: model ? "" : text || "",
    district: String(data.get("district") || "").trim(),
    min_price: numberInput(data.get("min_price")),
    max_price: numberInput(data.get("max_price")),
    year_min: year,
    year_max: form.elements.year_max ? numberInput(data.get("year_max")) : year,
    mileage: numberInput(data.get("mileage")),
    gearbox: data.get("gearbox") || "",
    photos: data.get("photos") === "on",
  };
}

function labelSearch(search) {
  return [search.model || search.query || "خودرو", search.city, search.district, search.year_min && fa.format(search.year_min), search.max_price && "تا " + fa.format(search.max_price) + " تومان"]
    .filter(Boolean).join(" · ");
}

function hydrateSearch(form, data) {
  if (form.elements.city) form.elements.city.value = data.city || "تهران";
  if (form.elements.model_text) {
    const field = form.elements.model_text;
    field.value = data.model || data.query || "";
    if (data.model) optionValues.get(field)?.set(data.model, data.model);
  }
  if (form.elements.year_min) form.elements.year_min.value = data.year_min ?? "";
}

function createSuggestions(input, kind, cityInput) {
  const list = document.getElementById(input.getAttribute("list"));
  const retained = new Map();
  optionValues.set(input, retained);
  let timer;
  let controller;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    controller?.abort();
    const query = input.value.trim();
    if (query.length < 2) return;
    timer = setTimeout(async () => {
      controller = new AbortController();
      const params = new URLSearchParams({ kind, q: query, city: cityInput?.value || "تهران" });
      try {
        const data = await api("/options?" + params, undefined, { signal: controller.signal });
        const rows = data.options || data.cities || data.districts || [];
        list.replaceChildren(...rows.map(row => {
          const option = el("option");
          option.value = row.label || row.name;
          if (kind === "model") {
            retained.set(option.value, row.value);
            retained.set(row.value, row.value);
          }
          return option;
        }));
      } catch { /* Free-text search remains available if suggestions fail. */ }
    }, 320);
  });
}

function safeUrl(raw, image = false) {
  try {
    const url = new URL(raw);
    const domain = url.hostname;
    const source = image ? domain === "divarcdn.com" || domain.endsWith(".divarcdn.com")
      : (domain === "divar.ir" || domain === "www.divar.ir") && url.pathname.startsWith("/v/");
    if (url.protocol !== "https:" || url.username || url.password || !source) return "";
    return url.href;
  } catch { return ""; }
}

function validToken(token) {
  return typeof token === "string" && /^[a-z0-9_-]{6,16}$/i.test(token);
}

function sourceLink(ad) {
  const href = safeUrl(ad.url) || (validToken(ad.token) ? "https://divar.ir/v/" + ad.token : "");
  if (!href) return null;
  const link = el("a", "button secondary small", icon("external"), "باز کردن در دیوار");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function priceText(value) {
  return Number.isFinite(value) && value > 0 ? fa.format(value) + " تومان" : "توافقی یا نامشخص";
}

function showPrice(ad) {
  return el("p", "ad-price", ad.price > 0 ? fa.format(ad.price) : "توافقی یا نامشخص",
    ad.price > 0 ? el("small", "", " تومان") : null);
}

function adCard(ad, index) {
  const title = ad.title || "آگهی خودرو";
  const photo = button("", null, () => openAd(ad.token), "ad-image");
  photo.className = "ad-image";
  photo.setAttribute("aria-label", "جزئیات " + title);
  photo.append(icon("car"));
  const url = safeUrl(ad.image || ad.images?.[0], true);
  if (url) {
    const image = el("img");
    image.src = url;
    image.alt = "";
    image.loading = index < 3 ? "eager" : "lazy";
    image.addEventListener("error", () => image.remove(), { once: true });
    photo.append(image);
  }
  if (ad.suspect_price) photo.append(el("span", "badge", "قیمت مشکوک"));
  else if (ad.deal_score !== undefined) photo.append(el("span", "badge good", "امتیاز " + fa.format(ad.deal_score)));
  const name = el("button", "ad-title", title);
  name.type = "button";
  name.title = title;
  name.addEventListener("click", () => openAd(ad.token));
  const meta = el("div", "ad-meta",
    ad.district ? el("span", "", icon("map-pin"), ad.district) : null,
    ad.info ? el("span", "", icon("gauge"), String(ad.info)) : null,
    Number.isFinite(ad.distance_m) ? el("span", "", fa.format(Math.round(ad.distance_m)) + " متر") : null,
  );
  const reason = ad.below_median_pct > 0
    ? el("p", "deal-reason", fa.format(ad.below_median_pct) + "٪ زیر میانهٔ نمونه")
    : null;
  const compare = button("مقایسه", "compare", () => toggleSelection(ad), "secondary small");
  compare.dataset.compareToken = ad.token;
  const value = button("بررسی قیمت", "tag", () => appraiseAd(ad.token), "secondary small");
  return el("article", "ad-card", photo, el("div", "ad-copy", name, showPrice(ad), meta, reason,
    el("div", "ad-actions", compare, value)));
}

function cards(data) {
  return (data || []).filter(ad => validToken(ad?.token)).map(adCard);
}

function updateCompareState() {
  const size = selected.size;
  $("#compare-count").hidden = !size;
  $("#compare-count").textContent = fa.format(size);
  $("#compare-dock").hidden = !size || currentPage === "compare";
  $("#dock-count").textContent = fa.format(size) + " آگهی انتخاب شد";
  $("#run-compare").disabled = size < 2;
  $$("#comparison-selection > *").forEach(item => item.remove());
  for (const [token, ad] of selected) {
    const remove = el("button", "chip selected", icon("close"), ad.title);
    remove.type = "button";
    remove.title = "حذف از مقایسه";
    remove.addEventListener("click", () => toggleSelection({ token }));
    $("#comparison-selection").append(remove);
  }
  for (const control of $$("[data-compare-token]")) {
    const active = selected.has(control.dataset.compareToken);
    control.setAttribute("aria-pressed", String(active));
    control.classList.toggle("chosen", active);
    control.replaceChildren(icon(active ? "check" : "compare"), active ? "انتخاب شد" : "مقایسه");
  }
}

function toggleSelection(ad) {
  if (selected.has(ad.token)) selected.delete(ad.token);
  else {
    if (selected.size >= 6) { say("حداکثر ۶ آگهی قابل مقایسه است.", true); return; }
    if (!validToken(ad.token)) return;
    selected.set(ad.token, { token: ad.token, title: ad.title || "آگهی " + ad.token });
  }
  sessionStorage.setItem("khodroyar-compare", JSON.stringify([...selected.values()]));
  $("#comparison-result").replaceChildren();
  updateCompareState();
}

function initSelection() {
  try {
    for (const ad of JSON.parse(sessionStorage.getItem("khodroyar-compare") || "[]").slice(0, 6)) {
      if (validToken(ad.token)) selected.set(ad.token, ad);
    }
  } catch { /* An expired browser selection can be ignored. */ }
}

function setService(ready) {
  const status = $("#workspace-status");
  status.className = "connection " + (ready ? "ready" : "offline");
  status.replaceChildren(el("i"), ready ? "دادهٔ زندهٔ دیوار" : "دیوار در دسترس نیست");
}

async function runSearch({ append = false } = {}) {
  let search;
  try {
    search = append ? currentSearch : formSearch(searchForm);
  } catch (error) {
    say(error.message, true);
    return;
  }
  if (append && !cursor) return;
  const version = ++searchVersion;
  const next = cursor;
  const more = $("#load-more");
  const meta = $("#result-meta");
  if (!append) {
    cursor = undefined;
    currentSearch = undefined;
    more.hidden = true;
    paintStatus(results, "در حال دریافت آگهی‌ها…", "loading");
  }
  more.disabled = true;
  results.setAttribute("aria-busy", "true");
  try {
    const data = await api("/search", { search, mode: currentMode, cursor: append ? next : null });
    if (version !== searchVersion) return;
    currentSearch = search;
    cursor = data.next_cursor;
    if (!append) results.replaceChildren();
    const existing = new Set($$("[data-compare-token]", results).map(item => item.dataset.compareToken));
    results.append(...cards((data.ads || []).filter(ad => !existing.has(ad.token))));
    const shown = results.querySelectorAll(".ad-card").length;
    if (!shown) paintStatus(results, "آگهی مطابق این فیلترها پیدا نشد. بودجه یا فیلترها را تغییر بده.");
    meta.textContent = fa.format(shown) + " آگهی نمایش داده شد";
    if (data.ignored && Object.keys(data.ignored).length) meta.textContent += " · برخی فیلترها اعمال نشدند";
    more.hidden = !cursor || cursor === next && append;
    updateCompareState();
    setService(true);
    if (!append && currentMode === "newest" && shown) {
      void api("/count", search).then(count => {
        if (version !== searchVersion || !Number.isFinite(count.count)) return;
        meta.textContent = fa.format(shown) + " آگهی از " + fa.format(count.count) + (count.or_more ? "+" : "") + " نتیجه";
      }).catch(() => {});
    }
  } catch (error) {
    if (version !== searchVersion) return;
    if (append) say(error.message, true);
    else {
      paintStatus(results, error.message, "error-box");
      meta.textContent = "جست‌وجو انجام نشد";
    }
    if (error.message.includes("ارتباط") || error.message.includes("پاسخ نداد")) setService(false);
  } finally {
    if (version === searchVersion) {
      more.disabled = false;
      results.setAttribute("aria-busy", "false");
    }
  }
}

function openDrawer(title) {
  $("#drawer-title").textContent = title;
  if (!drawer.open) drawer.showModal();
  drawer.scrollTop = 0;
  return ++drawerVersion;
}

function gallery(ad) {
  const sources = (ad.images || []).map(url => safeUrl(url, true)).filter(Boolean);
  if (!sources.length) return null;
  const main = el("img");
  main.src = sources[0];
  main.alt = "عکس " + (ad.title || "آگهی");
  const view = el("div", "gallery", main);
  if (sources.length > 1) {
    const thumbs = el("div", "thumbs");
    sources.forEach((url, index) => {
      const image = el("img");
      image.src = url;
      image.alt = "";
      image.loading = "lazy";
      const open = el("button", "", image);
      open.type = "button";
      open.setAttribute("aria-label", "نمایش عکس " + fa.format(index + 1));
      open.addEventListener("click", () => { main.src = url; });
      thumbs.append(open);
    });
    view.append(thumbs);
  }
  return view;
}

function specList(data) {
  return el("dl", "specs", ...Object.entries(data || {}).map(([key, value]) =>
    el("div", "", el("dt", "", key), el("dd", "", value == null ? "—" : String(value)))));
}

async function openAd(token) {
  if (!validToken(token)) return;
  const version = openDrawer("جزئیات آگهی");
  paintStatus(drawerBody, "در حال دریافت آگهی…", "loading");
  try {
    const ad = await api("/ads/" + token);
    if (version !== drawerVersion || !drawer.open) return;
    $("#drawer-title").textContent = ad.title || "جزئیات آگهی";
    const compare = button("مقایسه", "compare", () => toggleSelection(ad));
    compare.dataset.compareToken = ad.token;
    const actions = el("div", "dialog-actions", sourceLink(ad), compare,
      button("بررسی قیمت", "tag", () => appraiseAd(token)),
      button("آگهی‌های مشابه", "search", () => openRelated(token, "similar")),
      button("اطلاعات فروشنده", "car", () => openRelated(token, "seller")),
    );
    const status = el("p", "chart-caption");
    status.id = "drawer-status";
    status.setAttribute("role", "status");
    drawerBody.replaceChildren(gallery(ad) || document.createTextNode(""), showPrice(ad),
      ad.suspect_price ? el("span", "badge", "قیمت اعلام‌شده مشکوک است") : "",
      el("p", "chart-caption", [ad.city, ad.district].filter(Boolean).join(" · ")),
      actions, status, specList(ad.specs), el("p", "description", ad.description || "توضیحی ثبت نشده است."));
    updateCompareState();
  } catch (error) {
    if (version === drawerVersion) paintStatus(drawerBody, error.message, "error-box");
  }
}

async function openRelated(token, kind) {
  const version = openDrawer(kind === "seller" ? "اطلاعات عمومی فروشنده" : "آگهی‌های مشابه");
  paintStatus(drawerBody, "در حال دریافت اطلاعات…", "loading");
  try {
    const data = await api("/ads/" + token + "/" + kind);
    if (version !== drawerVersion || !drawer.open) return;
    const items = cards(data.ads);
    const back = button("بازگشت به آگهی", "left", () => openAd(token), "secondary small");
    const business = data.business || {};
    const dealer = data.dealer || {};
    drawerBody.replaceChildren(el("div", "dialog-actions", back),
      kind === "seller" ? el("div", "surface panel stack",
        el("h3", "", dealer.name || business.name || "فروشندهٔ شخصی"),
        specList({
          "آگهی‌های شخصی": data.personal_ads,
          "آگهی‌های نمایشگاه": dealer.active_ads ?? data.business_ads,
          "عضویت": dealer.member_since,
        })) : "",
      items.length ? el("div", "card-grid", ...items) : el("p", "empty", "آگهی خودروی دیگری برای نمایش پیدا نشد."));
    updateCompareState();
  } catch (error) {
    if (version === drawerVersion) paintStatus(drawerBody, error.message, "error-box");
  }
}

function renderCompare(data) {
  const ads = data.ads || [];
  const header = el("tr", "", el("th", "", "مشخصات"), ...ads.map(ad => el("th", "", ad.title || "آگهی")));
  const prices = el("tr", "", el("th", "", "قیمت پیشنهادی"), ...ads.map(ad =>
    el("td", "", priceText(ad.price), ad.suspect_price ? el("span", "badge", "قیمت مشکوک") : null)));
  const links = el("tr", "", el("th", "", "آگهی"), ...ads.map(ad => el("td", "", sourceLink(ad))));
  const diff = Object.entries(data.differences || {}).map(([key, values]) =>
    el("tr", "", el("th", "", key), ...ads.map(ad => el("td", "", values[ad.token] ?? "—"))));
  const same = Object.entries(data.shared_specs || {}).map(([key, value]) =>
    el("tr", "", el("th", "", key), ...ads.map(() => el("td", "", String(value)))));
  const unique = data.features_only_in || {};
  const features = Object.keys(unique).length ? el("tr", "", el("th", "", "امکانات متفاوت"), ...ads.map(ad => el("td", "", unique[ad.token]?.join?.("، ") || "—"))) : null;
  return el("div", "surface table-wrap", el("table", "comparison-table",
    el("thead", "", header), el("tbody", "", prices, links, ...diff, ...same, features)));
}

function stat(label, value) {
  return el("div", "stat", el("span", "", label), el("strong", "", value));
}

const verdicts = {
  "well below market": "خیلی پایین‌تر از نمونه",
  "below market": "پایین‌تر از نمونه",
  fair: "در بازهٔ معمول نمونه",
  "above market": "بالاتر از نمونه",
  "well above market": "خیلی بالاتر از نمونه",
  "insufficient comparables": "نمونهٔ مقایسه کافی نیست",
};

function renderAppraisal(data) {
  const count = data.comparable_ads ?? data.stats?.n;
  const percentage = Number(data.percentile ?? data.percentile_pct ?? data.percentile_cheaper);
  const verdict = verdicts[data.verdict] || "ارزیابی قیمت آگهی";
  const confidence = { low: "پایین", medium: "متوسط", high: "بالا" }[data.confidence];
  const bar = el("div", "percentile", el("span"));
  if (Number.isFinite(percentage)) {
    bar.style.setProperty("--position", Math.max(0, Math.min(99, percentage)) + "%");
    bar.setAttribute("aria-label", "جایگاه قیمت در نمونه " + fa.format(percentage) + " درصد");
  }
  const section = el("section", "surface panel stack", el("h2", "", verdict),
    el("div", "stats-grid",
      stat("قیمت بررسی‌شده", priceText(data.subject?.price)),
      stat("میانهٔ مشابه‌ها", data.stats?.median ? priceText(data.stats.median) : "—"),
      stat("آگهی قابل مقایسه", count == null ? "—" : fa.format(count)),
      stat("اطمینان ابزار", confidence || "—")),
    Number.isFinite(percentage) ? el("div", "", bar, el("p", "chart-caption", "صدک قیمت در نمونه " + fa.format(percentage))) : null,
    data.fair_band?.length === 2 ? el("p", "chart-caption", "بازهٔ میانی: " + priceText(data.fair_band[0]) + " تا " + priceText(data.fair_band[1])) : null,
    el("p", "chart-caption", "ارزیابی بر اساس قیمت پیشنهادی آگهی‌هاست. سال، کارکرد و بدنه را در انتخاب نمونه و بررسی خودرو در نظر بگیر."),
    validToken(data.subject?.token) ? el("div", "dialog-actions", button("آگهی‌های مشابه", "search", () => openRelated(data.subject.token, "similar"))) : null);
  return [section];
}

let appraisalVersion = 0;

async function runAppraisal(payload) {
  const version = ++appraisalVersion;
  const target = $("#appraisal-result");
  paintStatus(target, "در حال بررسی آگهی‌های مشابه…", "loading");
  try {
    const data = await api("/appraise", payload);
    if (version === appraisalVersion) target.replaceChildren(...renderAppraisal(data));
  } catch (error) {
    if (version === appraisalVersion) paintStatus(target, error.message, "error-box");
  }
}

function selectAppraisal(kind) {
  for (const button of $$("[data-appraisal]")) button.setAttribute("aria-pressed", String(button.dataset.appraisal === kind));
  $("#appraise-link").hidden = kind !== "link";
  $("#appraise-price").hidden = kind !== "price";
}

function appraiseAd(token) {
  if (!validToken(token)) return;
  if (drawer.open) drawer.close();
  navigate("appraise");
  selectAppraisal("link");
  $("#appraise-link").elements.ad.value = "https://divar.ir/v/" + token;
  void runAppraisal({ ad: token });
}

function svgNode(name, attributes) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function priceChart(points) {
  const valid = points.filter(point => Number.isFinite(point.median));
  if (!valid.length) return el("p", "empty", "دادهٔ قیمتی برای نمایش نمودار وجود ندارد.");
  const values = valid.map(point => point.median);
  const low = Math.min(...values) * .98;
  const high = Math.max(...values) * 1.02;
  const width = 660;
  const height = 205;
  const innerLeft = 69;
  const innerRight = 638;
  const innerTop = 18;
  const innerBottom = 171;
  const scaleY = value => innerBottom - (value - low) / (high - low || 1) * (innerBottom - innerTop);
  const xy = valid.map((point, i) => ({
    x: valid.length === 1 ? (innerLeft + innerRight) / 2 : innerLeft + (innerRight - innerLeft) * i / (valid.length - 1),
    y: scaleY(point.median),
  }));
  const svg = svgNode("svg", { viewBox: "0 0 " + width + " " + height, role: "img", "aria-label": "نمودار میانهٔ قیمت به تومان" });
  for (let step = 0; step <= 4; step++) {
    const value = low + (high - low) * step / 4;
    const y = scaleY(value);
    svg.append(svgNode("line", { x1: innerLeft, x2: innerRight, y1: y, y2: y, class: "axis-grid" }));
    const label = svgNode("text", { x: 58, y: y + 3, "text-anchor": "end" });
    label.textContent = fa.format(Math.round(value / 1_000_000)) + " م";
    svg.append(label);
  }
  if (xy.length > 1) {
    const outline = xy.map(({ x, y }) => x + "," + y).join(" ");
    svg.append(svgNode("polygon", { points: xy[0].x + "," + innerBottom + " " + outline + " " + xy.at(-1).x + "," + innerBottom, fill: "#e3f4ea" }));
    svg.append(svgNode("polyline", { points: outline, class: "line" }));
  }
  xy.forEach(({ x, y }, i) => {
    const point = valid[i];
    const day = displayDate(point.day || point.date);
    const circle = svgNode("circle", { cx: x, cy: y, r: 4, tabindex: "0", "aria-label": day + "، " + priceText(point.median) });
    const title = svgNode("title", {});
    title.textContent = day + " · " + priceText(point.median) + " · " + fa.format(point.n || 0) + " آگهی";
    circle.append(title);
    svg.append(circle);
    if (i === 0 || i === xy.length - 1 || i % Math.ceil(xy.length / 5) === 0) {
      const label = svgNode("text", { x, y: innerBottom + 23, "text-anchor": i === 0 && xy.length > 1 ? "start" : i === xy.length - 1 && xy.length > 1 ? "end" : "middle" });
      label.textContent = day;
      svg.append(label);
    }
  });
  return el("div", valid.length === 1 ? "chart single" : "chart", svg);
}

function renderMarket(search, data) {
  const stats = data.stats?.price;
  if (!stats) return [el("p", "empty", "آگهی قیمت‌دار کافی برای این مدل و شهر پیدا نشد.")];
  const districts = (data.by_district || []).slice(0, 8);
  const maximum = Math.max(1, ...districts.map(item => item.n));
  const tracking = button(data.tracking ? "توقف پایش روزانه" : "پایش روزانهٔ این مدل", data.tracking ? "close" : "bell", async () => {
    tracking.disabled = true;
    try {
      const response = await api("/market/tracked", { search, enabled: !data.tracking });
      data.tracking = response.enabled;
      tracking.replaceChildren(icon(data.tracking ? "close" : "bell"), data.tracking ? "توقف پایش روزانه" : "پایش روزانهٔ این مدل");
      say(data.tracking ? "پایش روزانه فعال شد." : "پایش روزانه متوقف شد.");
      await refreshTracked();
    } catch (error) { say(error.message, true); }
    finally { tracking.disabled = false; }
  }, "secondary small");
  return [
    el("div", "stats-grid",
      stat("میانهٔ قیمت", priceText(stats.median)),
      stat("چارک پایین", priceText(stats.p25)),
      stat("چارک بالا", priceText(stats.p75)),
      stat("آگهی قیمت‌دار در نمونه", fa.format(stats.n))),
    el("section", "surface panel stack",
      el("div", "section-heading", el("div", "", el("h2", "", "روند ثبت‌شدهٔ قیمت"), el("p", "", labelSearch(search))), tracking),
      priceChart(data.history || []),
      el("p", "chart-caption", "هر نقطه خلاصهٔ یک نمونه در روز ثبت است. با بررسی روزانه، نمودار ادامه پیدا می‌کند.")),
    (data.per_day || []).length > 1 ? el("section", "surface panel stack",
      el("h2", "", "قیمت آگهی‌های نمونه به تفکیک روز"),
      priceChart([...data.per_day].sort((a, b) => a.date.localeCompare(b.date))),
      el("p", "chart-caption", "نقاط بر اساس تاریخ آگهی‌های همین نمونه‌اند.")) : null,
    districts.length ? el("section", "surface panel stack", el("h2", "", "مقایسهٔ محله‌ها"),
      ...districts.map(item => {
        const bar = el("progress");
        bar.max = maximum;
        bar.value = item.n;
        bar.setAttribute("aria-label", fa.format(item.n) + " آگهی");
        return el("div", "district-row", el("span", "", item.district + " · " + fa.format(item.n)), bar, el("strong", "", priceText(item.median)));
      })) : null,
  ].filter(Boolean);
}

let marketVersion = 0;

async function runMarket(search) {
  const version = ++marketVersion;
  const target = $("#market-result");
  paintStatus(target, "در حال نمونه‌گیری قیمت‌ها از دیوار…", "loading");
  try {
    const data = await api("/market", search);
    if (version === marketVersion) target.replaceChildren(...renderMarket(search, data));
  } catch (error) {
    if (version === marketVersion) paintStatus(target, error.message, "error-box");
  }
}

async function refreshTracked() {
  try {
    const tracked = await api("/market/tracked");
    $("#tracked-series").replaceChildren(...tracked.map(search => {
      const item = el("button", "chip", icon("bell"), labelSearch(search));
      item.type = "button";
      item.addEventListener("click", () => { hydrateSearch($("#market-form"), search); void runMarket(search); });
      return item;
    }));
  } catch { /* Market lookup is still available. */ }
}

function setupMap() {
  if (map) { requestAnimationFrame(() => map.invalidateSize()); return; }
  if (!globalThis.L) {
    paintStatus($("#map-canvas"), "بارگذاری نقشه ممکن نشد.", "error-box");
    return;
  }
  const leaflet = globalThis.L;
  map = leaflet.map("map-canvas", { attributionControl: false, scrollWheelZoom: false }).setView([mapCenter.lat, mapCenter.lon], 12);
  const attribution = leaflet.control.attribution({ prefix: false }).addTo(map);
  mapLayer = leaflet.layerGroup().addTo(map);
  void api("/settings").then(settings => {
    if (typeof settings.tile_url !== "string" || !settings.tile_url.startsWith("https://")) return;
    leaflet.tileLayer(settings.tile_url, { maxZoom: 19 }).addTo(map);
    if (settings.tile_url.startsWith("https://tile.openstreetmap.org/")) {
      attribution.addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>');
    } else {
      const safe = el("span", "", settings.tile_attribution || "نقشه");
      attribution.addAttribution(safe.innerHTML);
    }
  }).catch(() => {});
}

async function runNearby(place, form) {
  const version = ++lastMapVersion;
  const target = $("#map-result");
  mapCenter = { lat: place.lat, lon: place.lon };
  const radius = Number(form.elements.radius.value);
  if (map) {
    const leaflet = globalThis.L;
    const area = leaflet.circle([place.lat, place.lon], { radius, color: "#138258", weight: 2, fillOpacity: .08 });
    mapLayer.clearLayers().addLayer(area);
    map.fitBounds(area.getBounds(), { padding: [15, 15], maxZoom: 15 });
  }
  paintStatus(target, "در حال دریافت آگهی‌های نزدیک…", "loading");
  try {
    const data = await api("/nearby", { lat: place.lat, lon: place.lon, radius, search: formSearch(form) });
    if (version !== lastMapVersion) return;
    const byPoint = new Map();
    for (const ad of data.ads || []) {
      if (!map || !Number.isFinite(ad.lat) || !Number.isFinite(ad.lon) || !ad.lat || !ad.lon) continue;
      const key = ad.lat + "," + ad.lon;
      if (!byPoint.has(key)) byPoint.set(key, []);
      byPoint.get(key).push(ad);
    }
    for (const ads of byPoint.values()) {
      const [first] = ads;
      const popup = el("div", "stack map-popup",
        first.approximate_area ? el("small", "", "مرکز محله " + (first.district || "")) : null,
        ...ads.map(ad => el("div", "map-popup-ad", el("strong", "", ad.title || "آگهی خودرو"),
          el("span", "", priceText(ad.price)), button("جزئیات", "car", () => openAd(ad.token), "secondary small"))));
      globalThis.L.marker([first.lat, first.lon], { icon: globalThis.L.divIcon({
        className: "map-pin", iconSize: [24, 24], html: ads.length > 1 ? fa.format(ads.length) : "",
      }) }).bindPopup(popup).addTo(mapLayer);
    }
    const items = cards(data.ads);
    const meta = fa.format(items.length) + " آگهی اطراف " + place.title;
    target.replaceChildren(el("div", "section-heading", el("div", "", el("h2", "", meta),
      data.approximate ? el("p", "", "نشانگرها مرکز محلهٔ آگهی را نمایش می‌دهند.") : null)),
      items.length ? el("div", "card-grid", ...items) : el("p", "empty", "در این محدوده آگهی پیدا نشد. شعاع یا نام مدل را تغییر بده."));
    updateCompareState();
  } catch (error) {
    if (version === lastMapVersion) paintStatus(target, error.message, "error-box");
  }
}

async function findPlaces(form) {
  const target = $("#place-choices");
  const version = ++lastMapVersion;
  paintStatus(target, "در حال پیدا کردن مکان…", "loading");
  try {
    const params = new URLSearchParams({ q: form.elements.place.value.trim(), ...mapCenter });
    const data = await api("/places?" + params);
    if (version !== lastMapVersion) return;
    if (!data.places?.length) {
      paintStatus(target, "مکان پیدا نشد. نام کامل‌تر محله یا میدان را وارد کن.");
      return;
    }
    const items = data.places.slice(0, 6).map(place => {
      const item = el("button", "chip", icon("map-pin"), place.title);
      item.type = "button";
      item.title = place.subtitle || place.title;
      item.addEventListener("click", () => {
        $$(".chip", target).forEach(node => node.classList.toggle("selected", node === item));
        void runNearby(place, form);
      });
      return item;
    });
    target.replaceChildren(...items);
    if (items.length === 1) items[0].click();
  } catch (error) {
    if (version === lastMapVersion) paintStatus(target, error.message, "error-box");
  }
}

function setUnread(count) {
  $("#nav-unread").hidden = !count;
  $("#nav-unread").textContent = fa.format(count);
  $("#notification-dot").hidden = !count;
}

function watchList(data) {
  const target = $("#watch-list");
  if (!data.watches.length) {
    paintStatus(target, "هنوز جست‌وجویی ذخیره نشده. از صفحهٔ کاوش یک جست‌وجو ذخیره کن.");
    return;
  }
  target.replaceChildren(...data.watches.map(watch => {
    const check = button("بررسی اکنون", "search", async () => {
      check.disabled = true;
      try {
        const result = await api("/watches/" + watch.id + "/check", {});
        say(result.matches ? fa.format(result.matches) + " آگهی مطابق پیدا شد." : "آگهی جدیدی پیدا نشد.");
        await refreshWatches();
      } catch (error) { say(error.message, true); }
      finally { check.disabled = false; }
    }, "secondary small");
    const remove = button("حذف", "trash", async () => {
      if (!confirm("این جست‌وجوی ذخیره‌شده حذف شود؟")) return;
      try {
        await api("/watches/" + watch.id, undefined, { method: "DELETE" });
        await refreshWatches();
      } catch (error) { say(error.message, true); }
    }, "secondary small");
    return el("div", "watch-item",
      el("div", "", el("strong", "watch-title", watch.name), watch.unread ? el("span", "badge good", fa.format(watch.unread) + " جدید") : null),
      el("p", "", labelSearch(watch.search)),
      el("p", "", "آخرین بررسی " + displayDate(watch.checked, true)),
      watch.issue ? el("span", "badge", watch.issue) : null,
      el("div", "", check, remove));
  }));
}

function alertList(data) {
  const target = $("#alert-list");
  if (!data.alerts.length) {
    paintStatus(target, "وقتی آگهی تازه‌ای مطابق جست‌وجویت پیدا شود، اینجا ظاهر می‌شود.");
    return;
  }
  target.replaceChildren(...data.alerts.map(alert => el("div", alert.seen ? "alert-item" : "alert-item unread",
    el("div", "", el("strong", "", alert.ad.title || "آگهی خودرو"), alert.seen ? null : el("span", "badge good", "جدید")),
    el("p", "", [alert.name, priceText(alert.ad.price), displayDate(alert.created, true)].join(" · ")),
    button("جزئیات آگهی", "car", () => openAd(alert.ad.token), "secondary small"))));
}

async function refreshWatches(render = currentPage === "watch") {
  try {
    const data = await api("/watches");
    setUnread(data.unread);
    if (render) {
      $("#watch-frequency").textContent = "بررسی خودکار تقریباً هر " + fa.format(data.interval_minutes) + " دقیقه انجام می‌شود.";
      watchList(data);
      alertList(await api("/alerts"));
    }
  } catch (error) {
    if (render) paintStatus($("#watch-list"), error.message, "error-box");
  }
}

function setMenu(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#scrim").hidden = !open;
  $("#show-menu").setAttribute("aria-expanded", String(open));
  if (open) $(".nav [aria-current='page']")?.focus();
}

function navigate(page) {
  if (location.hash !== "#" + page) location.hash = page;
  else route();
}

function route() {
  const slug = location.hash.slice(1);
  const nav = $$("[data-nav]").find(link => link.dataset.nav === slug) || $("[data-nav='search']");
  currentPage = nav.dataset.nav;
  const title = nav.childNodes[1]?.textContent.trim() || nav.textContent.trim();
  $("#page-title").textContent = title;
  document.title = title + " | خودرویار";
  for (const page of $$("[data-page]")) page.hidden = page.id !== "page-" + currentPage;
  for (const link of $$("[data-nav]")) {
    if (link === nav) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  window.scrollTo({ top: 0, behavior: "instant" });
  setMenu(false);
  updateCompareState();
  if (currentPage === "search" && !searchStarted) {
    searchStarted = true;
    void runSearch();
  }
  if (currentPage === "watch") void refreshWatches(true);
  if (currentPage === "market") void refreshTracked();
  if (currentPage === "map") setupMap();
}

for (const [part, form] of [["search", searchForm], ["market", $("#market-form")], ["appraise", $("#appraise-price")]]) {
  createSuggestions(form.elements.city, "city");
  createSuggestions(form.elements.model_text, "model", form.elements.city);
  if (part === "search") createSuggestions(form.elements.district, "district", form.elements.city);
}

$("#focus-search").addEventListener("click", () => {
  $("#search-panel").scrollIntoView({ behavior: "smooth" });
  searchForm.elements.model_text.focus({ preventScroll: true });
});
searchForm.addEventListener("submit", event => { event.preventDefault(); void runSearch(); });
$("#load-more").addEventListener("click", () => { void runSearch({ append: true }); });
for (const control of $$("[data-mode]")) {
  control.addEventListener("click", () => {
    currentMode = control.dataset.mode;
    for (const item of $$("[data-mode]")) item.setAttribute("aria-pressed", String(item === control));
    void runSearch();
  });
}

const exportMenu = $("#export-menu");
const exportOptions = $("#export-options");
exportMenu.addEventListener("click", () => {
  exportOptions.hidden = !exportOptions.hidden;
  exportMenu.setAttribute("aria-expanded", String(!exportOptions.hidden));
});
document.addEventListener("click", event => {
  if (!event.target.closest(".export-control")) {
    exportOptions.hidden = true;
    exportMenu.setAttribute("aria-expanded", "false");
  }
});
for (const control of $$("[data-format]")) {
  control.addEventListener("click", async () => {
    if (!currentSearch) { say("اول جست‌وجو را انجام بده.", true); return; }
    exportOptions.hidden = true;
    exportMenu.setAttribute("aria-expanded", "false");
    exportMenu.disabled = true;
    try {
      const format = control.dataset.format;
      const output = await api("/export?format=" + format, currentSearch, { raw: true });
      const url = URL.createObjectURL(await output.blob());
      const download = el("a");
      download.href = url;
      download.download = "khodroyar-ads." + format;
      download.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      say("فایل خروجی آماده شد.");
    } catch (error) { say(error.message, true); }
    finally { exportMenu.disabled = false; }
  });
}

const saveDialog = $("#save-dialog");
const saveForm = $("#save-form");
let searchToSave;
$("#save-search").addEventListener("click", () => {
  if (!currentSearch) { say("اول جست‌وجو را انجام بده.", true); return; }
  searchToSave = { ...currentSearch };
  $("#save-summary").textContent = labelSearch(searchToSave);
  saveForm.elements.name.value = (searchToSave.model || searchToSave.query || "خودرو") + " در " + searchToSave.city;
  saveDialog.showModal();
});
$("#close-save").addEventListener("click", () => saveDialog.close());
saveForm.addEventListener("submit", async event => {
  event.preventDefault();
  const control = event.submitter || $('button[type="submit"]', saveForm);
  control.disabled = true;
  try {
    await api("/watches", { name: saveForm.elements.name.value, search: searchToSave });
    saveDialog.close();
    say("جست‌وجو ذخیره شد. آگهی‌های تازه در بخش اعلان‌ها می‌آیند.");
    void refreshWatches();
  } catch (error) {
    saveDialog.close();
    say(error.message, true);
  } finally { control.disabled = false; }
});

$("#compare-form").addEventListener("submit", async event => {
  event.preventDefault();
  const input = $("#compare-link");
  let token = input.value.trim();
  if (!validToken(token)) {
    const url = safeUrl(token);
    token = url ? new URL(url).pathname.split("/").filter(Boolean).at(-1) : "";
  }
  if (!validToken(token)) { say("لینک معتبر دیوار را وارد کن.", true); return; }
  if (selected.has(token)) { say("این آگهی در مقایسه هست."); return; }
  const control = event.submitter || $('button[type="submit"]', event.currentTarget);
  control.disabled = true;
  try {
    const ad = await api("/ads/" + token);
    toggleSelection(ad);
    input.value = "";
  } catch (error) { say(error.message, true); }
  finally { control.disabled = false; }
});
$("#run-compare").addEventListener("click", async event => {
  const tokens = [...selected.keys()];
  const target = $("#comparison-result");
  const control = event.currentTarget;
  control.disabled = true;
  paintStatus(target, "در حال مقایسهٔ آگهی‌های انتخابی…", "loading");
  try {
    const data = await api("/compare", { tokens });
    if (tokens.join() === [...selected.keys()].join()) target.replaceChildren(renderCompare(data));
  } catch (error) {
    if (tokens.join() === [...selected.keys()].join()) paintStatus(target, error.message, "error-box");
  } finally { updateCompareState(); }
});

for (const control of $$("[data-appraisal]")) control.addEventListener("click", () => selectAppraisal(control.dataset.appraisal));
$("#appraise-link").addEventListener("submit", event => {
  event.preventDefault();
  void runAppraisal({ ad: event.currentTarget.elements.ad.value });
});
$("#appraise-price").addEventListener("submit", event => {
  event.preventDefault();
  try {
    void runAppraisal({ price: numberInput(event.currentTarget.elements.price.value), search: formSearch(event.currentTarget) });
  } catch (error) { say(error.message, true); }
});
$("#market-form").addEventListener("submit", event => {
  event.preventDefault();
  try { void runMarket(formSearch(event.currentTarget)); }
  catch (error) { say(error.message, true); }
});
$("#map-form").addEventListener("submit", event => { event.preventDefault(); void findPlaces(event.currentTarget); });
$("#mark-alerts").addEventListener("click", async () => {
  try { await api("/alerts/read", {}); await refreshWatches(true); }
  catch (error) { say(error.message, true); }
});

$("#show-menu").addEventListener("click", () => setMenu($("#scrim").hidden));
$("#scrim").addEventListener("click", () => { setMenu(false); $("#show-menu").focus(); });
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("#scrim").hidden) { setMenu(false); $("#show-menu").focus(); }
});
window.addEventListener("hashchange", route);
initSelection();
route();
void api("/health").then(() => {
  const status = $("#workspace-status");
  if (status.classList.contains("ready") || status.classList.contains("offline")) return;
  status.classList.add("ready");
  status.replaceChildren(el("i"), "سرویس آماده است");
}).catch(() => setService(false));
if (currentPage !== "watch") void refreshWatches();
setInterval(() => { if (!document.hidden) void refreshWatches(); }, 45000);
