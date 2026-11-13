// Telegram-бот: присылает в ЛС удалённые и изменённые сообщения (Business API).
// Команды владельца в чате: .mute (каждое сообщение собеседника сразу удаляется) и .unmute (вернуть).
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("BOT_TOKEN")!;
const SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const IGNORE_OWN = (Deno.env.get("IGNORE_OWN") ?? "1") === "1";
const API = `https://api.telegram.org/bot${TOKEN}`;
const CMD = /^\.(mute|unmute)$/i;
const NOTICE = "🔇 Пользователь замучен";
const MENU_IMAGE = Deno.env.get("MENU_IMAGE_URL") ??
  "https://raw.githubusercontent.com/viktor12345viktor202312345-stack/BOT-i/main/logo.jpg";
const POLICY_URL = Deno.env.get("POLICY_URL") ??
  "https://github.com/viktor12345viktor202312345-stack/BOT-i/blob/main/PRIVACY.md";
const SPAM = /^\.spam\s+(\d{1,3})\s+([\s\S]+)$/i;

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
  if (data.startsWith("m:")) {
    await onMenuCallback(q);
    return;
  }
  if (!data.startsWith("um:")) {
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    return;
  }
  const chatId = Number(data.slice(3));
  const { data: conns } = await db.from("connections").select("conn_id")
    .eq("owner_user_id", q.from.id);
  if (!conns?.length) { // нажал не владелец (например, собеседник)
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Размутить может только владелец", show_alert: true });
    return;
  }
  await db.from("muted_chats").delete()
    .in("conn_id", conns.map((c: Any) => c.conn_id)).eq("chat_id", chatId);
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: "🔔 Размучен" });

  const msg = q.message;
  if (msg?.business_connection_id) { // кнопка в чате: убираем сообщение «замучен»
    await tg("deleteBusinessMessages", { business_connection_id: msg.business_connection_id, message_ids: [msg.message_id] });
  } else if (msg) { // кнопка в ЛС: обновляем текст
    await tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: "🔔 Включён. Сообщения собеседника больше не удаляются." });
  }
}

async function onEdited(m: Any) {
  const owner = await getOwner(m.business_connection_id);
  if (!owner) return;
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

async function onStatus(chatId: number) {
  const lines: string[] = [];
  const conn = await db.from("connections").select("conn_id").eq("owner_chat_id", chatId);
  lines.push(conn.error ? `connections: ❌ ${conn.error.message}` : `Подключений бота к аккаунту: ${conn.data?.length ?? 0}`);
  const msgs = await db.from("messages").select("*", { count: "exact", head: true });
  lines.push(msgs.error ? `messages: ❌ ${msgs.error.message}` : `Сообщений сохранено: ${msgs.count ?? 0}`);
  const mt = await db.from("muted_chats").select("*", { count: "exact", head: true });
  lines.push(mt.error ? `muted_chats: ❌ ${mt.error.message}` : `Заглушённых чатов: ${mt.count ?? 0}`);
  lines.push(`IGNORE_OWN: ${IGNORE_OWN ? "1 (твои удаления и правки не показываются)" : "0"}`);
  await tg("sendMessage", { chat_id: chatId, text: lines.join("\n") });
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

async function screen(key: string): Promise<{ text: string; kb: Any }> {
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
          "<code>.spam N фраза</code> — отправить фразу N раз (1–99)\n\n" +
          "В этом боте:\n" +
          "/menu — это меню\n" +
          "/status — состояние бота",
        kb: { inline_keyboard: [backRow] },
      };
    case "sub":
      return {
        text: "<b>💎 Подписка</b>\n\nСкоро здесь появятся тарифы. Пока бот работает бесплатно.",
        kb: { inline_keyboard: [backRow] },
      };
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
  const { text, kb } = await screen(String(q.data).slice(2));
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  const msg = q.message;
  if (!msg) return;
  const common = { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: "HTML", reply_markup: kb };
  if (msg.photo) await tg("editMessageCaption", { ...common, caption: text });
  else await tg("editMessageText", { ...common, text });
}

Deno.serve(async (req) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const u = await req.json();
    if (u.business_connection) await onConnection(u.business_connection);
    else if (u.business_message) await onMessage(u.business_message);
    else if (u.edited_business_message) await onEdited(u.edited_business_message);
    else if (u.deleted_business_messages) await onDeleted(u.deleted_business_messages);
    else if (u.callback_query) await onCallback(u.callback_query);
    else if (u.message?.text) {
      const cmd = u.message.text.split(/[\s@]/)[0].toLowerCase();
      if (cmd === "/menu" || cmd === "/start") await showMenu(u.message.chat.id);
      else if (cmd === "/status") await onStatus(u.message.chat.id);
    }
  } catch (err) {
    console.error(err);
  }
  return new Response("ok"); // всегда 200, чтобы Telegram не слал повторы
});
