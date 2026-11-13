// Telegram-бот: присылает в ЛС удалённые и изменённые сообщения (Business API).
// Команды владельца в чате: .mute (каждое сообщение собеседника сразу удаляется) и .unmute (вернуть).
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("BOT_TOKEN")!;
const SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const IGNORE_OWN = (Deno.env.get("IGNORE_OWN") ?? "1") === "1";
const API = `https://api.telegram.org/bot${TOKEN}`;
const CMD = /^\.(mute|unmute)$/i;
const NOTICE = "🔇 Пользователь замучен";
const ADMIN_ID = Number(Deno.env.get("ADMIN_ID") ?? "7804388091"); // только он может открыть /admin
const MENU_IMAGE = Deno.env.get("MENU_IMAGE_URL") ??
  "https://raw.githubusercontent.com/viktor12345viktor202312345-stack/BOT-i/main/logo.jpg";
const POLICY_URL = Deno.env.get("POLICY_URL") ??
  "https://github.com/viktor12345viktor202312345-stack/BOT-i/blob/main/PRIVACY.md";

// ---------- подписка ----------
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// пробный период в минутах (7 дней); для тестов можно задать секрет TRIAL_MINUTES=1
const TRIAL_MS = Number(Deno.env.get("TRIAL_MINUTES") ?? "10080") * MIN;
// тестовый тариф за 1 звезду скрыт; для тестов можно задать секрет SHOW_TEST_PLAN=1
const SHOW_TEST_PLAN = (Deno.env.get("SHOW_TEST_PLAN") ?? "0") === "1";
const PLANS: Record<string, { title: string; stars: number; ms: number; test?: boolean }> = {
  m1: { title: "1 месяц", stars: 30, ms: 30 * DAY },
  m3: { title: "3 месяца", stars: 75, ms: 90 * DAY },
  m6: { title: "6 месяцев", stars: 145, ms: 180 * DAY },
  m12: { title: "12 месяцев", stars: 250, ms: 365 * DAY },
  test: { title: "Тест 2 минуты", stars: 1, ms: 2 * MIN, test: true },
};
const SPAM = /^\.spam\s+(\d{1,3})\s+([\s\S]+)$/i;
const NOLI = /^\.noli$/i;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// deno-lint-ignore no-explicit-any
type Any = any;

async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error(method, r.status, await r.text());
  return r.ok;
}

const esc = (s: string) =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, n = 3000) => (s.length > n ? s.slice(0, n) + "…" : s);
const fullName = (u: Any) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ") : "Неизвестно";
const chatName = (c: Any) =>
  c?.title ?? [c?.first_name, c?.last_name].filter(Boolean).join(" ") ?? String(c?.id);

function who(u: Any) {
  let s = esc(fullName(u));
  if (u?.username) s += ` (@${esc(u.username)})`;
  if (u?.id) s += ` [<code>${u.id}</code>]`;
  return s;
}

function extractMedia(m: Any): [string | null, string | null] {
  if (m.photo?.length) return ["photo", m.photo[m.photo.length - 1].file_id];
  for (
    const k of ["video", "voice", "video_note", "audio", "document", "sticker", "animation"]
  ) {
    if (m[k]) return [k, m[k].file_id];
  }
  return [null, null];
}

async function saveMessage(m: Any) {
  const [media_type, file_id] = extractMedia(m);
  const { error } = await db.from("messages").upsert({
    conn_id: m.business_connection_id,
    chat_id: m.chat.id,
    msg_id: m.message_id,
    from_id: m.from?.id ?? null,
    from_name: fullName(m.from),
    username: m.from?.username ?? null,
    text: m.text ?? m.caption ?? "",
    media_type,
    file_id,
  });
  if (error) console.error("save", error.message);
}

async function getOwner(connId: string) {
  const { data } = await db.from("connections").select("*").eq("conn_id", connId)
    .maybeSingle();
  return data as { owner_user_id: number; owner_chat_id: number } | null;
}

async function isMuted(connId: string, chatId: number) {
  const { data } = await db.from("muted_chats").select("chat_id")
    .eq("conn_id", connId).eq("chat_id", chatId).maybeSingle();
  return !!data;
}

async function sendMedia(chat: number, type: string, fileId: string, caption: string) {
  const map: Record<string, [string, string]> = {
    photo: ["sendPhoto", "photo"],
    video: ["sendVideo", "video"],
    voice: ["sendVoice", "voice"],
    audio: ["sendAudio", "audio"],
    document: ["sendDocument", "document"],
    animation: ["sendAnimation", "animation"],
  };
  if (map[type]) {
    const [method, field] = map[type];
    return tg(method, { chat_id: chat, [field]: fileId, caption: clip(caption, 1000), parse_mode: "HTML" });
  }
  if (type === "video_note") await tg("sendVideoNote", { chat_id: chat, video_note: fileId });
  if (type === "sticker") await tg("sendSticker", { chat_id: chat, sticker: fileId });
  return tg("sendMessage", { chat_id: chat, text: caption, parse_mode: "HTML" });
}

// ---------- обработчики ----------
async function onConnection(c: Any) {
  if (c.is_enabled) {
    await db.from("connections").upsert({
      conn_id: c.id,
      owner_user_id: c.user.id,
      owner_chat_id: c.user_chat_id,
    });
    if (!(await isBanned(c.user.id))) await startTrial(c.user.id, c.user_chat_id);
    await tg("sendMessage", { chat_id: c.user_chat_id, text: "✅ Бот подключён и следит за твоими чатами.\n\n.mute в чате — все новые сообщения собеседника будут удаляться, .unmute — вернуть." });
  } else {
    await db.from("connections").delete().eq("conn_id", c.id);
    await tg("sendMessage", { chat_id: c.user_chat_id, text: "⛔ Бот отключён от аккаунта." });
  }
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendWithRetry(body: Record<string, unknown>) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return true;
    if (r.status === 429) { // лимит Telegram: ждём сколько просит и пробуем ещё раз
      const j = await r.json().catch(() => null);
      await sleep(((j?.parameters?.retry_after ?? 3) + 1) * 1000);
      continue;
    }
    console.error("spam send", r.status, await r.text());
    return false;
  }
  return false;
}

async function runSpam(connId: string, chat: Any, ownerChat: number, n: number, phrase: string) {
  let sent = 0;
  for (let i = 0; i < n; i++) {
    const ok = await sendWithRetry({ business_connection_id: connId, chat_id: chat.id, text: phrase });
    if (!ok) break;
    sent++;
    await sleep(700); // пауза, чтобы не упереться в лимиты Telegram
  }
  if (sent < n) {
    await tg("sendMessage", { chat_id: ownerChat, text: `⚠️ Рассылка прервалась: отправлено ${sent} из ${n}` });
  }
}

async function onSpam(m: Any, ownerChat: number, match: RegExpMatchArray) {
  const connId = m.business_connection_id;
  const n = Number(match[1]);
  const phrase = match[2].trim().replace(/^["«“]([\s\S]*)["»”]$/, "$1").trim();
  await tg("deleteBusinessMessages", { business_connection_id: connId, message_ids: [m.message_id] });
  // фраза с точки в начале запрещена, чтобы бот не запустил сам себя командой
  if (n < 1 || n > 99 || !phrase || phrase.startsWith(".")) {
    await tg("sendMessage", {
      chat_id: ownerChat,
      text: "Формат: .spam N фраза\nN от 1 до 99, фраза не должна начинаться с точки.",
    });
    return;
  }
  // отвечаем Telegram сразу, а рассылка идёт в фоне
  const job = runSpam(connId, m.chat, ownerChat, n, phrase);
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(job);
  else await job;
}

const unmuteBtn = (chatId: number) => ({
  inline_keyboard: [[{ text: "🔔 Размутить", callback_data: `um:${chatId}` }]],
});

async function onMessage(m: Any) {
  const connId = m.business_connection_id;
  const owner = await getOwner(connId);
  if (owner && !(await hasAccess(owner))) return; // подписка закончилась: бот не реагирует
  const fromOwner = !!owner && m.from?.id === owner.owner_user_id;

  // чат заглушен: сообщения собеседника сразу удаляем и не сохраняем
  if (owner && !fromOwner && await isMuted(connId, m.chat.id)) {
    await tg("deleteBusinessMessages", { business_connection_id: connId, message_ids: [m.message_id] });
    return;
  }

  await saveMessage(m);
  const spam = (m.text ?? "").trim().match(SPAM);
  if (spam && owner && fromOwner) {
    await onSpam(m, owner.owner_chat_id, spam);
    return;
  }
  if (owner && fromOwner && NOLI.test((m.text ?? "").trim())) {
    await startGame(m);
    return;
  }
  const match = (m.text ?? "").trim().match(CMD);
  if (!match || !owner || !fromOwner) return; // команды только от владельца

  const mute = match[1].toLowerCase() === "mute";
  if (mute) {
    await db.from("muted_chats").upsert({ conn_id: connId, chat_id: m.chat.id });
  } else {
    await db.from("muted_chats").delete().eq("conn_id", connId).eq("chat_id", m.chat.id);
  }
  // убираем саму команду из чата (нужно право боту удалять сообщения)
  const removed = await tg("deleteBusinessMessages", { business_connection_id: connId, message_ids: [m.message_id] });

  if (!removed) {
    await tg("sendMessage", {
      chat_id: owner.owner_chat_id,
      text: "⚠️ Не удалось удалить команду из чата. Включи боту право удалять сообщения: " +
        "Настройки → Telegram для бизнеса → Чат-боты → твой бот. Без него автоудаление тоже не сработает.",
    });
  }

  // сообщение прямо в чате: «Пользователь замучен» + кнопка (если Telegram разрешит кнопки в бизнес-чате)
  if (mute) {
    const inChat = { business_connection_id: connId, chat_id: m.chat.id, text: NOTICE };
    const ok = await tg("sendMessage", { ...inChat, reply_markup: unmuteBtn(m.chat.id) });
    if (!ok) await tg("sendMessage", inChat);
  }
}

async function onCallback(q: Any) {
  const data: string = q.data ?? "";
  if (data.startsWith("t:")) {
    await onGameCallback(q);
    return;
  }
  if (data.startsWith("a:")) {
    if (q.from.id === ADMIN_ID) await onAdminCallback(q);
    else await tg("answerCallbackQuery", { callback_query_id: q.id });
    return;
  }
  if (data.startsWith("m:")) {
    await onMenuCallback(q);
    return;
  }
  if (data.startsWith("buy:")) {
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    await sendPlanInvoice(q.from.id, data.slice(4));
    return;
  }
  if (!data.startsWith("um:")) {
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    return;
  }
  const msg = q.message;
  let connIds: string[];
  let chatId = Number(data.slice(3));
  if (msg?.business_connection_id) {
    // кнопка в самом чате: размутить может только владелец этого подключения, то есть тот, кто замутил
    const owner = await getOwner(msg.business_connection_id);
    if (!owner || owner.owner_user_id !== q.from.id) {
      await tg("answerCallbackQuery", {
        callback_query_id: q.id,
        text: "Размутить может только тот, кто замутил",
        show_alert: true,
      });
      return; // сообщение не трогаем
    }
    connIds = [msg.business_connection_id];
    chatId = msg.chat.id;
  } else { // кнопка из ЛС с ботом (старые сообщения)
    const { data: conns } = await db.from("connections").select("conn_id").eq("owner_user_id", q.from.id);
    if (!conns?.length) {
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Размутить может только владелец", show_alert: true });
      return;
    }
    connIds = conns.map((c: Any) => c.conn_id);
  }
  await db.from("muted_chats").delete().in("conn_id", connIds).eq("chat_id", chatId);
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: "🔔 Размучен" });

  if (msg?.business_connection_id) { // убираем сообщение «замучен»
    await tg("deleteBusinessMessages", { business_connection_id: msg.business_connection_id, message_ids: [msg.message_id] });
  } else if (msg) {
    await tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: "🔔 Включён. Сообщения собеседника больше не удаляются." });
  }
}

async function onEdited(m: Any) {
  const owner = await getOwner(m.business_connection_id);
  if (!owner) return;
  if (!(await hasAccess(owner))) return;
  const fromOwner = m.from?.id === owner.owner_user_id;
  if (!fromOwner && await isMuted(m.business_connection_id, m.chat.id)) return;
  const { data: old } = await db.from("messages").select("text")
    .eq("conn_id", m.business_connection_id).eq("chat_id", m.chat.id)
    .eq("msg_id", m.message_id).maybeSingle();
  const newText = m.text ?? m.caption ?? "";
  await saveMessage(m);
  if (IGNORE_OWN && fromOwner) return;
  if (old && old.text === newText) return; // изменилось не то, что видно в тексте
  const oldText = old ? old.text : "(неизвестно — сообщение пришло до подключения бота)";
  await tg("sendMessage", {
    chat_id: owner.owner_chat_id,
    parse_mode: "HTML",
    text: `✏️ <b>Сообщение изменено</b>\nЧат: ${esc(chatName(m.chat))}\nОт: ${who(m.from)}\n\n` +
      `<b>Было:</b>\n${esc(clip(oldText))}\n\n<b>Стало:</b>\n${esc(clip(newText))}`,
  });
}

async function onDeleted(e: Any) {
  const owner = await getOwner(e.business_connection_id);
  if (!owner) return;
  if (!(await hasAccess(owner))) return;
  if (await isMuted(e.business_connection_id, e.chat.id)) return;
  const { data: rows } = await db.from("messages").select("*")
    .eq("conn_id", e.business_connection_id).eq("chat_id", e.chat.id)
    .in("msg_id", e.message_ids);
  const byId = new Map((rows ?? []).map((r: Any) => [r.msg_id, r]));
  for (const id of e.message_ids as number[]) {
    const r = byId.get(id) as Any;
    if (!r) continue; // бот это сообщение не видел (например, отправлено самим ботом при .spam)
    if (CMD.test((r.text ?? "").trim())) continue; // удалённая команда .mute/.unmute
    if ((r.text ?? "").startsWith(NOTICE)) continue; // наше сообщение «замучен»
    if (SPAM.test((r.text ?? "").trim())) continue; // удалённая команда .spam
    if (NOLI.test((r.text ?? "").trim())) continue; // удалённая команда .noli
    if (IGNORE_OWN && r.from_id === owner.owner_user_id) continue;
    const when = new Date(r.created_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
    const header = `🗑 <b>Сообщение удалено</b>\nЧат: ${esc(chatName(e.chat))}\n` +
      `От: ${who({ id: r.from_id, username: r.username, first_name: r.from_name })}\n` +
      `Получено: ${when} (МСК)`;
    const body = r.text ? `\n\n${esc(clip(r.text))}` : "";
    if (r.media_type && r.file_id) {
      await sendMedia(owner.owner_chat_id, r.media_type, r.file_id, header + body);
    } else {
      await tg("sendMessage", { chat_id: owner.owner_chat_id, parse_mode: "HTML", text: header + body });
    }
  }
}

// ---------- подписка ----------
type Sub = { user_id: number; expires_at: string; expired_notified: boolean };

async function getSub(userId: number) {
  const { data } = await db.from("subscriptions").select("*").eq("user_id", userId).maybeSingle();
  return data as Sub | null;
}

function fmtMs(ms: number) {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m} мин.`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ч.`;
  return `${Math.round(h / 24)} дн.`;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }) + " МСК";

// пробный период выдаётся один раз на аккаунт (при первом подключении)
async function startTrial(userId: number, chatId: number) {
  const expires = new Date(Date.now() + TRIAL_MS).toISOString();
  const { data } = await db.from("subscriptions")
    .upsert({ user_id: userId, expires_at: expires }, { onConflict: "user_id", ignoreDuplicates: true })
    .select();
  if (data?.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: `🎁 Пробный период: ${fmtMs(TRIAL_MS)}\nПродлить: /menu → 💎 Подписка.`,
    });
    return data[0] as Sub;
  }
  return await getSub(userId);
}

// true, если подписка активна; после окончания один раз сообщаем об этом
async function hasAccess(owner: { owner_user_id: number; owner_chat_id: number }) {
  if (await isBanned(owner.owner_user_id)) return false; // заблокирован админом
  let sub = await getSub(owner.owner_user_id);
  if (!sub) sub = await startTrial(owner.owner_user_id, owner.owner_chat_id); // подключился до появления подписок
  if (!sub) return false;
  if (new Date(sub.expires_at).getTime() > Date.now()) return true;
  if (!sub.expired_notified) {
    await db.from("subscriptions").update({ expired_notified: true }).eq("user_id", owner.owner_user_id);
    await tg("sendMessage", {
      chat_id: owner.owner_chat_id,
      text: "⌛ Подписка закончилась. Бот больше не реагирует на команды и не присылает уведомления.\nПродлить: /menu → 💎 Подписка.",
    });
  }
  return false;
}

async function subScreen(userId: number) {
  const sub = await getSub(userId);
  let status = "Пробный период начнётся, когда ты подключишь бота.";
  if (sub) {
    const left = new Date(sub.expires_at).getTime() - Date.now();
    status = left > 0
      ? `✅ Активна до ${fmtDate(sub.expires_at)} (осталось ${fmtMs(left)})`
      : `⌛ Закончилась ${fmtDate(sub.expires_at)}. Бот не реагирует на команды и не присылает уведомления.`;
  }
  const btn = (k: string) => ({ text: `${PLANS[k].title} — ${PLANS[k].stars} ⭐`, callback_data: `buy:${k}` });
  const rows: Any[] = [[btn("m1"), btn("m3")], [btn("m6"), btn("m12")]];
  if (SHOW_TEST_PLAN) rows.push([{ text: "🧪 Тест 2 мин — 1 ⭐", callback_data: "buy:test" }]);
  rows.push(backRow);
  return {
    text: `<b>💎 Подписка</b>\n\n${status}\n\nВыбери срок. Оплата в Telegram Stars ⭐`,
    kb: { inline_keyboard: rows },
  };
}

async function sendPlanInvoice(chatId: number, key: string) {
  const plan = PLANS[key];
  if (!plan || (plan.test && !SHOW_TEST_PLAN)) return;
  await tg("sendInvoice", {
    chat_id: chatId,
    title: `BlackWave: ${plan.title}`,
    description: `Доступ к BlackWave на срок: ${plan.title}. Оплата в Telegram Stars.`,
    payload: `plan:${key}`,
    currency: "XTR", // Telegram Stars
    prices: [{ label: plan.title, amount: plan.stars }],
  });
}

async function onPreCheckout(q: Any) {
  const key = String(q.invoice_payload ?? "").replace(/^plan:/, "");
  const plan = PLANS[key];
  const ok = !!plan && q.currency === "XTR" && q.total_amount === plan.stars && !(plan.test && !SHOW_TEST_PLAN);
  await tg(
    "answerPreCheckoutQuery",
    ok
      ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: "Этот тариф недоступен. Открой /menu заново." },
  );
}

async function onPayment(m: Any) {
  const pay = m.successful_payment;
  const key = String(pay.invoice_payload ?? "").replace(/^plan:/, "");
  const plan = PLANS[key];
  if (!plan) {
    console.error("unknown plan in payment", pay.invoice_payload);
    return;
  }
  const userId = m.from.id;
  const { error } = await db.from("payments").insert({
    charge_id: pay.telegram_payment_charge_id,
    user_id: userId,
    plan: key,
    stars: pay.total_amount,
  });
  if (error?.code === "23505") return; // этот платёж уже обработан
  if (error) console.error("payment save", error.message); // деньги получены, доступ всё равно выдаём

  const expires = await extendSub(userId, plan.ms);
  await tg("sendMessage", {
    chat_id: m.chat.id,
    text: `✅ Оплачено: ${plan.title}. Подписка активна до ${fmtDate(expires)}.`,
  });
}

// ---------- меню ----------
let botUsername: string | null = null;
async function getBotUsername() {
  if (botUsername) return botUsername;
  const r = await fetch(`${API}/getMe`);
  const j = await r.json().catch(() => null);
  botUsername = j?.result?.username ?? null;
  return botUsername;
}

const WELCOME =
  "<b>Добро пожаловать в BlackWave</b> 🌊\n\n" +
  "Присылаю в личку сообщения, которые собеседники удаляют или меняют в твоих чатах: кто, где и что именно было.\n\n" +
  "Выбери действие ниже 👇";

const mainKb = {
  inline_keyboard: [
    [{ text: "🔗 Подключить", callback_data: "m:connect" }, { text: "📖 Команды", callback_data: "m:cmds" }],
    [{ text: "💎 Подписка", callback_data: "m:sub" }],
    [{ text: "🔒 Политика конфиденциальности", callback_data: "m:policy" }],
  ],
};
const backRow = [{ text: "⬅️ Назад", callback_data: "m:home" }];

async function screen(key: string, userId: number): Promise<{ text: string; kb: Any }> {
  switch (key) {
    case "connect": {
      const u = await getBotUsername();
      return {
        text: "<b>🔗 Подключение</b>\n\n" +
          "1. Открой Telegram → Настройки → Telegram для бизнеса → Чат-боты\n" +
          `2. Введи ${u ? "@" + u : "имя этого бота"} и выбери его\n` +
          "3. Выдай доступ к чатам и включи права на удаление сообщений\n\n" +
          "Когда всё получится, я напишу «✅ Бот подключён».",
        kb: { inline_keyboard: [backRow] },
      };
    }
    case "cmds":
      return {
        text: "<b>📖 Команды</b>\n\n" +
          "В чате с собеседником (пишешь ты):\n" +
          "<code>.mute</code> — удалять каждое его сообщение\n" +
          "<code>.unmute</code> — вернуть как было\n" +
          "<code>.spam N фраза</code> — отправить фразу N раз (1–99)\n" +
          "<code>.noli</code> — крестики-нолики с собеседником\n\n" +
          "В этом боте:\n" +
          "/menu — это меню",
        kb: { inline_keyboard: [backRow] },
      };
    case "sub":
      return await subScreen(userId);
    case "policy":
      return {
        text: "<b>🔒 Политика конфиденциальности</b>\n\n" +
          "Бот работает только в чатах, к которым ты сам дал доступ через Telegram Business.\n\n" +
          "<b>Что хранится:</b> текст сообщений, имя и ID отправителя, ссылки на медиа (file_id) и время получения.\n" +
          "<b>Зачем:</b> чтобы показать тебе сообщение, если его удалят или изменят.\n" +
          "<b>Кому видно:</b> только владельцу аккаунта.\n" +
          "Данные не передаются третьим лицам (кроме инфраструктуры Telegram и Supabase, где работает бот). " +
          "Сообщения заглушённых через .mute собеседников не сохраняются.\n\n" +
          "Отключи бота в настройках Telegram, и новые сообщения перестанут сохраняться.",
        kb: { inline_keyboard: [[{ text: "📄 Полная версия", url: POLICY_URL }], backRow] },
      };
    default:
      return { text: WELCOME, kb: mainKb };
  }
}

async function showMenu(chatId: number) {
  const ok = await tg("sendPhoto", {
    chat_id: chatId,
    photo: MENU_IMAGE,
    caption: WELCOME,
    parse_mode: "HTML",
    reply_markup: mainKb,
  });
  // если картинка не загрузилась, показываем меню без неё
  if (!ok) await tg("sendMessage", { chat_id: chatId, text: WELCOME, parse_mode: "HTML", reply_markup: mainKb });
}

async function onMenuCallback(q: Any) {
  const { text, kb } = await screen(String(q.data).slice(2), q.from.id);
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  const msg = q.message;
  if (!msg) return;
  const common = { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: "HTML", reply_markup: kb };
  if (msg.photo) await tg("editMessageCaption", { ...common, caption: text });
  else await tg("editMessageText", { ...common, text });
}

// ---------- крестики-нолики (.noli) ----------
// Состояние игры хранится в самих кнопках: t:<поле>:<чей ход>:<владелец играет X (1/0)>:<клетка>
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const SYM: Record<string, string> = { X: "❌", O: "⭕" };
const EMPTY_BOARD = "---------";

function winner(b: string): string | null {
  for (const [a, c, d] of LINES) {
    if (b[a] !== "-" && b[a] === b[c] && b[a] === b[d]) return b[a];
  }
  return null;
}

function boardKb(board: string, turn: string, xo: number, over: boolean) {
  const rows: Any[] = [];
  for (let r = 0; r < 3; r++) {
    rows.push([0, 1, 2].map((c) => {
      const i = r * 3 + c;
      const ch = board[i];
      return {
        text: ch === "X" ? "❌" : ch === "O" ? "⭕" : "▫️",
        callback_data: over ? "t:noop" : `t:${board}:${turn}:${xo}:${i}`,
      };
    }));
  }
  if (over) rows.push([{ text: "🔄 Играть снова", callback_data: "t:again" }]);
  return { inline_keyboard: rows };
}

function renderGame(board: string, turn: string, xo: number, ownerNm: string, partnerNm: string, result?: string) {
  const xName = xo === 1 ? ownerNm : partnerNm;
  const oName = xo === 1 ? partnerNm : ownerNm;
  let status: string;
  if (result === "draw") status = "🤝 Ничья!";
  else if (result) status = `🏆 Победил ${SYM[result]} ${esc(result === "X" ? xName : oName)}!`;
  else if (board === EMPTY_BOARD) status = `🎲 По жребию первым ходит ${SYM.X} ${esc(xName)}`;
  else status = `Ходит: ${SYM[turn]} ${esc(turn === "X" ? xName : oName)}`;
  return {
    text: `🎮 <b>Крестики-нолики</b>\n\n❌ — ${esc(xName)}\n⭕ — ${esc(oName)}\n\n${status}`,
    kb: boardKb(board, turn, xo, !!result),
  };
}

async function userName(id: number) {
  const r = await fetch(`${API}/getChat?chat_id=${id}`);
  const j = await r.json().catch(() => null);
  const c = j?.result;
  return c ? ([c.first_name, c.last_name].filter(Boolean).join(" ") || c.title || "Игрок") : "Игрок";
}

// .noli в чате: убираем команду и отправляем игру, первый ход по жребию
async function startGame(m: Any) {
  const connId = m.business_connection_id;
  await tg("deleteBusinessMessages", { business_connection_id: connId, message_ids: [m.message_id] });
  const xo = Math.random() < 0.5 ? 1 : 0;
  const g = renderGame(EMPTY_BOARD, "X", xo, fullName(m.from), chatName(m.chat));
  await tg("sendMessage", {
    business_connection_id: connId,
    chat_id: m.chat.id,
    text: g.text,
    parse_mode: "HTML",
    reply_markup: g.kb,
  });
}

async function onGameCallback(q: Any) {
  const answer = (text?: string) => tg("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) });
  const msg = q.message;
  const connId = msg?.business_connection_id;
  if (!msg || !connId) return void await answer();
  const owner = await getOwner(connId);
  if (!owner) return void await answer();

  const ownerId = owner.owner_user_id;
  const partnerId = msg.chat.id;
  if (q.from.id !== ownerId && q.from.id !== partnerId) return void await answer("Это игра не для тебя");

  const parts = String(q.data).split(":");
  if (parts[1] === "noop") return void await answer();

  const ownerNm = q.from.id === ownerId ? fullName(q.from) : await userName(ownerId);
  const partnerNm = q.from.id === partnerId ? fullName(q.from) : chatName(msg.chat);
  const edit = (g: { text: string; kb: Any }) =>
    tg("editMessageText", {
      business_connection_id: connId,
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      text: g.text,
      parse_mode: "HTML",
      reply_markup: g.kb,
    });

  if (parts[1] === "again") { // новая игра, первый ход снова по жребию
    const xo = Math.random() < 0.5 ? 1 : 0;
    await answer();
    await edit(renderGame(EMPTY_BOARD, "X", xo, ownerNm, partnerNm));
    return;
  }

  const [, board, turn, xoStr, cellStr] = parts;
  const xo = Number(xoStr);
  const cell = Number(cellStr);
  if (!/^[XO-]{9}$/.test(board ?? "") || (turn !== "X" && turn !== "O") || (xo !== 0 && xo !== 1) || !(cell >= 0 && cell <= 8)) {
    return void await answer();
  }
  // X принадлежит владельцу, если xo = 1
  const expectedId = (turn === "X") === (xo === 1) ? ownerId : partnerId;
  if (q.from.id !== expectedId) return void await answer("Сейчас не твой ход");
  if (board[cell] !== "-") return void await answer("Клетка занята");

  const nb = board.slice(0, cell) + turn + board.slice(cell + 1);
  const w = winner(nb);
  const result = w ?? (nb.includes("-") ? undefined : "draw");
  await answer();
  await edit(renderGame(nb, turn === "X" ? "O" : "X", xo, ownerNm, partnerNm, result));
}

// ---------- админка ----------
const say = (chatId: number, text: string) => tg("sendMessage", { chat_id: chatId, text });

async function isBanned(userId: number) {
  const { data } = await db.from("banned_users").select("user_id").eq("user_id", userId).maybeSingle();
  return !!data;
}

// продлевает подписку: от текущего конца, если она ещё идёт, иначе от сейчас
async function extendSub(userId: number, ms: number) {
  const sub = await getSub(userId);
  const base = sub && new Date(sub.expires_at).getTime() > Date.now()
    ? new Date(sub.expires_at).getTime()
    : Date.now();
  const expires = new Date(base + ms).toISOString();
  await db.from("subscriptions").upsert({ user_id: userId, expires_at: expires, expired_notified: false });
  return expires;
}

// "30" или "30d" — дни, "12h" — часы, "90m" — минуты
function parseDuration(s: string): number | null {
  const m = s.trim().toLowerCase().match(/^(\d{1,5})\s*([dhmдчм]?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === "h" || unit === "ч" ? n * 60 * MIN : unit === "m" || unit === "м" ? n * MIN : n * DAY;
  if (n < 1 || ms > 3650 * DAY) return null;
  return ms;
}

const ADMIN_PROMPTS: Record<string, string> = {
  give: "🎁 Выдать подписку\nОтветь на это сообщение: ID и срок. Срок: число с буквой d (дни), h (часы) или m (минуты), без буквы — дни.\nПример: 123456789 30d",
  ban: "🚫 Заблокировать\nОтветь на это сообщение: ID пользователя.",
  unban: "✅ Разблокировать\nОтветь на это сообщение: ID пользователя.",
  info: "🔎 Информация\nОтветь на это сообщение: ID пользователя.",
};

async function showAdmin(chatId: number) {
  await tg("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: "🛠 <b>Админка BlackWave</b>\n\nВыбери действие. Бот попросит ответить на его сообщение с ID пользователя.",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎁 Выдать подписку", callback_data: "a:give" }],
        [{ text: "🚫 Заблокировать", callback_data: "a:ban" }, { text: "✅ Разблокировать", callback_data: "a:unban" }],
        [{ text: "🔎 Информация", callback_data: "a:info" }, { text: "📊 Статистика", callback_data: "a:stats" }],
      ],
    },
  });
}

async function adminStats() {
  const head = { count: "exact" as const, head: true };
  const subsAll = await db.from("subscriptions").select("*", head);
  const subsActive = await db.from("subscriptions").select("*", head).gt("expires_at", new Date().toISOString());
  const banned = await db.from("banned_users").select("*", head);
  const msgs = await db.from("messages").select("*", head);
  const pays = await db.from("payments").select("stars");
  const stars = (pays.data ?? []).reduce((a: number, r: Any) => a + (r.stars ?? 0), 0);
  const errs = [subsAll, subsActive, banned, msgs, pays].map((r) => r.error?.message).filter(Boolean);
  return `📊 Статистика\n\nС подпиской или пробным: ${subsAll.count ?? 0}\nАктивных сейчас: ${subsActive.count ?? 0}\n` +
    `Заблокировано: ${banned.count ?? 0}\nСообщений в базе: ${msgs.count ?? 0}\n` +
    `Оплат: ${pays.data?.length ?? 0} (всего ${stars} ⭐)` +
    (errs.length ? `\n\n⚠️ Ошибки базы:\n${errs.join("\n")}` : "");
}

async function adminInfo(id: number) {
  const sub = await getSub(id);
  const banned = await isBanned(id);
  const pays = await db.from("payments").select("stars").eq("user_id", id);
  const conns = await db.from("connections").select("conn_id", { count: "exact", head: true }).eq("owner_user_id", id);
  let subLine = "нет";
  if (sub) {
    const left = new Date(sub.expires_at).getTime() - Date.now();
    subLine = left > 0
      ? `активна до ${fmtDate(sub.expires_at)} (осталось ${fmtMs(left)})`
      : `закончилась ${fmtDate(sub.expires_at)}`;
  }
  const stars = (pays.data ?? []).reduce((a: number, r: Any) => a + (r.stars ?? 0), 0);
  return `🔎 Пользователь ${id}\n\nПодписка: ${subLine}\nСтатус: ${banned ? "🚫 заблокирован" : "ок"}\n` +
    `Подключений бота: ${conns.count ?? 0}\nОплат: ${pays.data?.length ?? 0} (${stars} ⭐)`;
}

async function onAdminCallback(q: Any) {
  const act = String(q.data).slice(2);
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  const chatId = q.message?.chat?.id ?? q.from.id;
  if (act === "stats") {
    await say(chatId, await adminStats());
    return;
  }
  const prompt = ADMIN_PROMPTS[act];
  if (prompt) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: prompt,
      reply_markup: { force_reply: true, input_field_placeholder: "ID пользователя" },
    });
  }
}

// ответ админа на сообщение-запрос бота
async function onAdminReply(m: Any) {
  const quoted: string = m.reply_to_message?.text ?? "";
  const hit = Object.entries(ADMIN_PROMPTS).find(([, p]) => quoted.startsWith(p.split("\n")[0]));
  if (!hit) return;
  const act = hit[0];
  const parts = (m.text ?? "").trim().split(/\s+/);
  const id = Number(parts[0]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    await say(m.chat.id, "ID должен быть числом. Открой /admin и попробуй снова.");
    return;
  }

  if (act === "give") {
    const ms = parseDuration(parts[1] ?? "");
    if (!ms) {
      await say(m.chat.id, "Не понял срок. Пример: 123456789 30d (d — дни, h — часы, m — минуты).");
      return;
    }
    const expires = await extendSub(id, ms);
    const delivered = await say(id, `🎁 Тебе выдана подписка. Активна до ${fmtDate(expires)}.`);
    await say(
      m.chat.id,
      `✅ Выдано ${id} на ${parts[1]}\nАктивна до ${fmtDate(expires)}\n` +
        (delivered ? "Пользователю отправлено уведомление." : "Уведомление не доставлено (пользователь не запускал бота)."),
    );
  } else if (act === "ban") {
    if (id === ADMIN_ID) {
      await say(m.chat.id, "Себя заблокировать нельзя.");
      return;
    }
    await db.from("banned_users").upsert({ user_id: id });
    await say(m.chat.id, `🚫 Заблокирован: ${id}`);
  } else if (act === "unban") {
    await db.from("banned_users").delete().eq("user_id", id);
    await say(m.chat.id, `✅ Разблокирован: ${id}`);
  } else if (act === "info") {
    await say(m.chat.id, await adminInfo(id));
  }
}

Deno.serve(async (req) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const u = await req.json();
    const actor = u.message?.from?.id ?? u.callback_query?.from?.id ?? u.pre_checkout_query?.from?.id;
    if (actor && actor !== ADMIN_ID && await isBanned(actor)) {
      if (u.pre_checkout_query) {
        await tg("answerPreCheckoutQuery", { pre_checkout_query_id: u.pre_checkout_query.id, ok: false, error_message: "Доступ заблокирован" });
      } else if (u.callback_query) {
        await tg("answerCallbackQuery", { callback_query_id: u.callback_query.id, text: "🚫 Доступ заблокирован", show_alert: true });
      } else if (u.message) {
        await say(u.message.chat.id, "🚫 Доступ к боту заблокирован.");
      }
      return new Response("ok");
    }
    if (u.business_connection) await onConnection(u.business_connection);
    else if (u.business_message) await onMessage(u.business_message);
    else if (u.edited_business_message) await onEdited(u.edited_business_message);
    else if (u.deleted_business_messages) await onDeleted(u.deleted_business_messages);
    else if (u.callback_query) await onCallback(u.callback_query);
    else if (u.pre_checkout_query) await onPreCheckout(u.pre_checkout_query);
    else if (u.message?.successful_payment) await onPayment(u.message);
    else if (u.message?.text) {
      const cmd = u.message.text.split(/[\s@]/)[0].toLowerCase();
      if (cmd === "/menu" || cmd === "/start") await showMenu(u.message.chat.id);
      else if (u.message.from?.id === ADMIN_ID && cmd === "/admin") await showAdmin(u.message.chat.id);
      else if (u.message.from?.id === ADMIN_ID && u.message.reply_to_message) await onAdminReply(u.message);
    }
  } catch (err) {
    console.error(err);
  }
  return new Response("ok"); // всегда 200, чтобы Telegram не слал повторы
});
