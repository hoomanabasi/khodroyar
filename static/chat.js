const form = document.querySelector("#composer");
const prompt = document.querySelector("#prompt");
const send = document.querySelector("#send");
const reset = document.querySelector("#reset");
const welcome = document.querySelector("#welcome");
const messages = document.querySelector("#messages");
const conversation = document.querySelector("#conversation");
const connection = document.querySelector("#connection");
const history = [];
let activeRequest;

const toolLabels = {
  dv_search: "جست‌وجوی آگهی",
  dv_cheapest: "آگهی‌های ارزان‌تر",
  dv_best_for_budget: "پیشنهاد بر اساس بودجه",
  dv_find_deals: "آگهی‌های زیر میانهٔ نمونه",
  dv_market: "آمار قیمت آگهی‌ها",
  dv_appraise: "ارزیابی قیمت",
  dv_post: "جزئیات آگهی",
  dv_similar: "آگهی‌های مشابه",
  dv_compare: "مقایسه آگهی‌ها",
};

function updateComposer() {
  prompt.style.height = "auto";
  prompt.style.height = Math.min(prompt.scrollHeight, 146) + "px";
  send.disabled = Boolean(activeRequest) || !prompt.value.trim();
}

function scrollToLatest() {
  conversation.scrollTop = conversation.scrollHeight;
}

function appendInline(parent, text) {
  const syntax = /\[([^\]\n]+)\]\((https:\/\/(?:www\.)?divar\.ir\/v\/[^\s)]+)\)|\*\*([^*]+)\*\*|https:\/\/(?:www\.)?divar\.ir\/v\/[^\s،؛<>)]+/gu;
  let offset = 0;
  for (const match of text.matchAll(syntax)) {
    parent.append(text.slice(offset, match.index));
    if (match[3]) {
      const bold = document.createElement("strong");
      bold.textContent = match[3];
      parent.append(bold);
    } else {
      const link = document.createElement("a");
      link.href = match[2] ?? match[0];
      link.textContent = match[1] ?? "مشاهده آگهی در دیوار";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      parent.append(link);
    }
    offset = match.index + match[0].length;
  }
  parent.append(text.slice(offset));
}

function renderAnswer(parent, text) {
  let list;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const item = line.match(/^([-*]|[\d۰-۹٠-٩]+[.)])\s+(.+)$/u);
    if (item) {
      const tag = /^[-*]$/.test(item[1]) ? "ul" : "ol";
      if (list?.localName !== tag) {
        list = document.createElement(tag);
        parent.append(list);
      }
      const entry = document.createElement("li");
      appendInline(entry, item[2]);
      list.append(entry);
    } else {
      list = undefined;
      if (!line) continue;
      const paragraph = document.createElement("p");
      appendInline(paragraph, line.replace(/^#{1,6}\s+/u, ""));
      parent.append(paragraph);
    }
  }
}

function addMessage(role, text, state = "", tools = []) {
  const row = document.createElement("article");
  row.className = ["message", role, state].filter(Boolean).join(" ");
  row.setAttribute("aria-label", role === "user" ? "شما" : "خودرویار");

  if (role === "assistant") {
    const avatar = document.querySelector(".brand-mark").cloneNode(true);
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    row.append(avatar);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "assistant" && !state) renderAnswer(bubble, text);
  else bubble.textContent = text;

  const labels = tools.map(tool => toolLabels[tool]).filter(Boolean);
  if (labels.length) {
    const badge = document.createElement("small");
    badge.className = "tools";
    badge.textContent = "دیوار · " + labels.join("، ");
    bubble.append(badge);
  }
  row.append(bubble);
  messages.append(row);
  scrollToLatest();
  return row;
}

async function checkConnection() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error();
    connection.className = "connection ready";
    connection.replaceChildren(document.createElement("i"), "سرویس آماده است");
  } catch {
    connection.className = "connection offline";
    connection.replaceChildren(document.createElement("i"), "سرویس در دسترس نیست");
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || activeRequest) return;

  const request = new AbortController();
  activeRequest = request;
  welcome.hidden = true;
  prompt.value = "";
  updateComposer();
  addMessage("user", text);
  const waiting = addMessage("assistant", "در حال آماده‌کردن پاسخ…", "waiting");
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history: history.slice(-12) }),
      signal: request.signal,
    });
    const data = await response.json();
    if (activeRequest !== request) return;
    if (!response.ok) {
      const error = typeof data.detail === "string" ? data.detail : "پیام پذیرفته نشد. متن پیام را بررسی کنید.";
      addMessage("assistant", error, "error");
      if (!prompt.value) prompt.value = text;
      return;
    }
    history.push({ role: "user", content: text }, { role: "assistant", content: data.answer });
    if (history.length > 12) history.splice(0, history.length - 12);
    addMessage("assistant", data.answer, "", data.tools);
  } catch {
    if (request.signal.aborted) return;
    addMessage("assistant", "ارتباط با سرویس قطع شد. دوباره تلاش کنید.", "error");
    if (!prompt.value) prompt.value = text;
    void checkConnection();
  } finally {
    waiting.remove();
    if (activeRequest === request) {
      activeRequest = undefined;
      updateComposer();
      scrollToLatest();
    }
  }
});

prompt.addEventListener("input", updateComposer);
prompt.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!send.disabled) form.requestSubmit();
  }
});

reset.addEventListener("click", () => {
  activeRequest?.abort();
  activeRequest = undefined;
  history.length = 0;
  messages.replaceChildren();
  welcome.hidden = false;
  prompt.value = "";
  updateComposer();
  prompt.focus();
});

for (const button of document.querySelectorAll("[data-prompt]")) {
  button.addEventListener("click", () => {
    prompt.value = button.dataset.prompt;
    updateComposer();
    prompt.focus();
  });
}

updateComposer();
void checkConnection();
