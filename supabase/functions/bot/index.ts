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
// ID премиум-эмодзи для заголовков и кнопок. Пока пусто: показываются обычные эмодзи.
// Узнать ID: администратор отправляет боту сообщение с нужным премиум-эмодзи, бот отвечает ID.
const CE: Record<string, string> = {
  // back: "5368324170671202286",
};
const ce = (name: string, fallback: string) =>
  CE[name] ? `<tg-emoji emoji-id="${CE[name]}">${fallback}</tg-emoji>` : fallback;
const backBtn = (cb: string) =>
  CE.back
    ? { text: "Назад", callback_data: cb, style: "danger", icon_custom_emoji_id: CE.back }
    : { text: "⬅️ Назад", callback_data: cb, style: "danger" };
const MENU_IMAGE = Deno.env.get("MENU_IMAGE_URL") ??
  "https://raw.githubusercontent.com/viktor12345viktor202312345-stack/BOT-i/blob/main/logo.jpg";
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
const NOMUTE = /^\.nomute(\s+off)?$/i;
const COIN = /^\.coin$/i;
const TYPE = /^\.type\s+([\s\S]+)$/i;
const CALC = /^\.calc\s+([\s\S]+)$/i;
const RPS = /^\.knb$/i;
const RPS_TITLE = "✊✌️✋ Камень, ножницы, бумага";
const HELP = /^\.(help|menu)$/i;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// deno-lint-ignore no-explicit-any
type Any = any;

async function tgRaw(method: string, body: Record<string, unknown>) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.ok) return { ok: true, description: "" };
  const raw = await r.text();
  console.error(method, r.status, raw);
  let description = raw;
  try {
    description = JSON.parse(raw).description ?? raw;
  } catch { /* оставляем как есть */ }
  return { ok: false, description: String(description).slice(0, 300) };
}

async function tg(method: string, body: Record<string, unknown>) {
  return (await tgRaw(method, body)).ok;
}

const esc = (s: string) =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, n = 3000) => (s.length > n ? s.slice(0, n) + "…" : s);
const fullName = (u: Any) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ") : "Неизвестно";
const chatName = (c: Any) =>
  c?.title ?? [c?.first_name, c?.last_name].filter(Boolean).join(" ") ?? String(c?.id);

function who(u: Any) {
  let s = `<b>${esc(fullName(u))}</b>`;
  if (u?.username) s += ` · @${esc(u.username)}`;
  if (u?.id) s += ` · <code>${u.id}</code>`;
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
    return tg(method, { chat_id: chat, [field]: fileId, caption, parse_mode: "HTML" });
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
    await tg("sendMessage", {
      chat_id: c.user_chat_id,
      parse_mode: "HTML",
      text: "✅ <b>Бот подключён</b>\n\nТеперь я слежу за твоими чатами и пришлю сюда удалённые и изменённые сообщения.\n\n" +
        "<blockquote>Команды для чата смотри в разделе «Команды»</blockquote>",
      reply_markup: { inline_keyboard: [[{ text: "📜 Команды", callback_data: "m:cmds" }, { text: "💎 Подписка", callback_data: "m:sub" }]] },
    });
  } else {
    await db.from("connections").delete().eq("conn_id", c.id);
    await tg("sendMessage", {
      chat_id: c.user_chat_id,
      parse_mode: "HTML",
      text: "⛔ <b>Бот отключён</b>\n\nЯ больше не вижу твои чаты. Подключить снова: /menu → 🔌 Подключить.",
    });
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

  // подписка и мут проверяются параллельно, чтобы сообщение заглушённого удалялось как можно быстрее
  const [ok, muted] = owner
    ? await Promise.all([hasAccess(owner), fromOwner ? false : isMuted(connId, m.chat.id)])
    : [true, false];
  if (!ok) return; // подписка закончилась: бот не реагирует
  if (muted) { // заглушённый собеседник: сообщение удаляем сразу и не сохраняем
    await deleteHard(connId, [m.message_id]);
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
  const nm = (m.text ?? "").trim().match(NOMUTE);
  if (nm && owner && fromOwner) {
    await onAntiMute(m, !nm[1]);
    return;
  }
  if (owner && fromOwner) {
    const cmdText = (m.text ?? "").trim();
    if (COIN.test(cmdText)) {
      await onCoin(m);
      return;
    }
    if (RPS.test(cmdText)) {
      await startRps(m);
      return;
    }
    if (HELP.test(cmdText)) {
      await sendHelp(m);
      return;
    }
    const calcMatch = cmdText.match(CALC);
    if (calcMatch) {
      await onCalc(m, calcMatch[1]);
      return;
    }
    const typeMatch = cmdText.match(TYPE);
    if (typeMatch) {
      await onType(m, typeMatch[1].trim());
      return;
    }
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
        "Настройки → Аккаунт → Автоматизация чатов → твой бот. Без него автоудаление тоже не сработает.",
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
  if (data.startsWith("n:")) {
    await onAntiMuteCallback(q);
    return;
  }
  if (data.startsWith("k:")) {
    await onRpsCallback(q);
    return;
  }
  if (data.startsWith("h:")) {
    await onHelpCallback(q);
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
  if (!fromOwner && await isMuted(m.business_connection_id, m.chat.id)) {
    await deleteHard(m.business_connection_id, [m.message_id]); // правка у заглушённого тоже удаляется
    return;
  }
  const { data: old } = await db.from("messages").select("text")
    .eq("conn_id", m.business_connection_id).eq("chat_id", m.chat.id)
    .eq("msg_id", m.message_id).maybeSingle();
  const newText = m.text ?? m.caption ?? "";
  // правки служебных сообщений (анимация .type, игра, уведомления бота) не показываем и не сохраняем
  if (isServiceText((old?.text ?? "").trim()) || isServiceText(newText.trim())) return;
  await saveMessage(m);
  if (IGNORE_OWN && fromOwner) return;
  if (old && old.text === newText) return; // изменилось не то, что видно в тексте
  const oldText = old ? old.text : "(неизвестно — сообщение пришло до подключения бота)";
  await tg("sendMessage", {
    chat_id: owner.owner_chat_id,
    parse_mode: "HTML",
    text: `✏️ <b>Сообщение изменено</b>\n\n👤 ${who(m.from)}\n💬 ${esc(chatName(m.chat))}\n\n` +
      `<b>Было</b>\n<blockquote>${esc(clip(oldText || "—", 1500))}</blockquote>\n` +
      `<b>Стало</b>\n<blockquote>${esc(clip(newText || "—", 1500))}</blockquote>`,
  });
}

async function onDeleted(e: Any) {
  const owner = await getOwner(e.business_connection_id);
  if (!owner) return;
  if (!(await hasAccess(owner))) return;
  if (await isAntiMute(e.business_connection_id, e.chat.id)) await restoreOwn(e, owner);
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
    if (NOMUTE.test((r.text ?? "").trim())) continue; // удалённая команда .nomute
    if (isCommandText((r.text ?? "").trim())) continue; // удалённая команда (.coin, .calc, .type и др.)
    if (isServiceText((r.text ?? "").trim())) continue; // служебное сообщение бота
    if (IGNORE_OWN && r.from_id === owner.owner_user_id) continue;
    const header = `🗑 <b>Сообщение удалено</b>\n\n👤 ${
      who({ id: r.from_id, username: r.username, first_name: r.from_name })
    }\n💬 ${esc(chatName(e.chat))}\n🕒 ${fmtDate(r.created_at)}`;
    const limit = r.media_type ? 600 : 3000; // подпись к медиа в Telegram короче
    const body = r.text
      ? `\n\n<blockquote${r.text.length > 300 ? " expandable" : ""}>${esc(clip(r.text, limit))}</blockquote>`
      : "";
    if (r.media_type && r.file_id) {
      const sent = await sendMedia(owner.owner_chat_id, r.media_type, r.file_id, header + body);
      if (!sent) { // медиа не отправилось (например, подпись слишком длинная): присылаем карточку текстом
        await tg("sendMessage", { chat_id: owner.owner_chat_id, parse_mode: "HTML", text: header + body });
      }
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
      parse_mode: "HTML",
      text: `🎁 <b>Пробный период активирован</b>\n\nПолный доступ на <b>${fmtMs(TRIAL_MS)}</b>. Потом можно продлить подпиской.`,
      reply_markup: { inline_keyboard: [[{ text: "💎 Подписка", callback_data: "m:sub" }]] },
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
      parse_mode: "HTML",
      text: "⌛ <b>Подписка закончилась</b>\n\nБот больше не реагирует на команды и не присылает уведомления. Продли подписку, и всё заработает снова.",
      reply_markup: { inline_keyboard: [[{ text: "💎 Продлить", callback_data: "m:sub" }]] },
    });
  }
  return false;
}

const BAR = (ratio: number) => {
  const n = Math.max(0, Math.min(10, Math.round(ratio * 10)));
  return "▰".repeat(n) + "▱".repeat(10 - n);
};
const PLAN_ICON: Record<string, string> = { m1: "💎", m3: "💎", m6: "🔥", m12: "👑", test: "🧪" };
const PLAN_SAVE: Record<string, number> = { m3: 17, m6: 19, m12: 31 }; // выгода против помесячной оплаты, %

async function subScreen(userId: number) {
  const sub = await getSub(userId);
  let status = "🎁 Пробный период начнётся, когда ты подключишь бота";
  if (sub) {
    const left = new Date(sub.expires_at).getTime() - Date.now();
    status = left > 0
      ? `✅ <b>Активна</b> до ${fmtDate(sub.expires_at)}\n${BAR(left / (30 * DAY))} осталось ${fmtMs(left)}`
      : `⌛ <b>Закончилась</b> ${fmtDate(sub.expires_at)}`;
  }
  const btn = (k: string) => [{
    text: `${PLAN_ICON[k]} ${PLANS[k].title} — ${PLANS[k].stars} ⭐${PLAN_SAVE[k] ? ` · −${PLAN_SAVE[k]}%` : ""}`,
    callback_data: `buy:${k}`,
  }];
  const rows: Any[] = [btn("m1"), btn("m3"), btn("m6"), btn("m12")];
  if (SHOW_TEST_PLAN) rows.push(btn("test"));
  rows.push(backRow);
  return {
    text: `${ce("sub", "💎")} <b>Подписка</b>\n\n<blockquote>${status}</blockquote>\n\n` +
      "<b>Что входит</b>\n▫️ уведомления об удалённых и изменённых сообщениях\n▫️ мут, анти-мут, игры и утилиты в чатах\n\n" +
      "Оплата в Telegram Stars ⭐",
    kb: { inline_keyboard: rows },
  };
}

async function sendPlanInvoice(chatId: number, key: string) {
  const plan = PLANS[key];
  if (!plan || (plan.test && !SHOW_TEST_PLAN)) return;
  const invoice: Record<string, unknown> = {
    chat_id: chatId,
    title: `BlackWave: ${plan.title}`,
    description: `Полный доступ к BlackWave: ${plan.title}. Оплата в Telegram Stars ⭐`,
    payload: `plan:${key}`,
    currency: "XTR", // Telegram Stars
    prices: [{ label: plan.title, amount: plan.stars }],
  };
  // со счётом показываем логотип; если картинка не загрузится, отправляем без неё
  if (!(await tg("sendInvoice", { ...invoice, photo_url: MENU_IMAGE }))) await tg("sendInvoice", invoice);
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
    parse_mode: "HTML",
    text: `✅ <b>Оплата прошла</b>\n\n💎 Тариф: <b>${plan.title}</b>\n📅 Активна до <b>${fmtDate(expires)}</b>\n\nСпасибо, что с нами! 🌊`,
  });
}

// ---------- Rich Messages: круглые кнопки внутри сообщения (Bot API 10.3) ----------
// RICH_MENU=0 в секретах Supabase возвращает обычные кнопки под сообщением
const RICH_MENU = (Deno.env.get("RICH_MENU") ?? "1") === "1";

const decodeEntities = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const simplify = (a: Any[]): Any => (a.length === 0 ? "" : a.length === 1 ? a[0] : a);

// инлайн-теги нашего HTML (<b>, <i>, <code>, <tg-emoji>) превращаем в RichText
function inlineToRich(line: string): Any {
  const re = /<(\/?)([a-z-]+)([^>]*)>|([^<]+)/gi;
  type Frame = { tag: string; attrs: string; kids: Any[]; parent: Any[] };
  const TYPES: Record<string, string> = {
    b: "bold", strong: "bold", i: "italic", em: "italic", u: "underline", ins: "underline",
    s: "strikethrough", del: "strikethrough", code: "code",
  };
  const root: Any[] = [];
  const stack: Frame[] = [];
  let cur = root;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[4] !== undefined) {
      cur.push(decodeEntities(m[4]));
      continue;
    }
    const tag = m[2].toLowerCase();
    if (m[1] !== "/") {
      const frame: Frame = { tag, attrs: m[3] ?? "", kids: [], parent: cur };
      stack.push(frame);
      cur = frame.kids;
      continue;
    }
    const f = stack.pop();
    if (!f) continue;
    cur = f.parent;
    if (TYPES[f.tag]) {
      cur.push({ type: TYPES[f.tag], text: simplify(f.kids) });
    } else if (f.tag === "tg-emoji") {
      const id = /emoji-id="(\d+)"/.exec(f.attrs)?.[1];
      const inner = simplify(f.kids);
      if (id) cur.push({ type: "custom_emoji", custom_emoji_id: id, alternative_text: typeof inner === "string" ? inner : "🙂" });
      else cur.push(...f.kids);
    } else {
      cur.push(...f.kids);
    }
  }
  while (stack.length) { // незакрытые теги просто разворачиваем
    const f = stack.pop()!;
    cur = f.parent;
    cur.push(...f.kids);
  }
  return simplify(root);
}

// каждая строка становится абзацем, <blockquote> становится блоком цитаты
function htmlToBlocks(html: string): Any[] {
  const blocks: Any[] = [];
  let quote: Any[] | null = null;
  for (const raw of html.split("\n")) {
    let line = raw.trim();
    const opens = /<blockquote[^>]*>/i.test(line);
    const closes = /<\/blockquote>/i.test(line);
    line = line.replace(/<\/?blockquote[^>]*>/gi, "").trim();
    if (opens) quote = [];
    if (line) (quote ?? blocks).push({ type: "paragraph", text: inlineToRich(line) });
    if (closes && quote) {
      if (quote.length) blocks.push({ type: "blockquote", blocks: quote });
      quote = null;
    }
  }
  if (quote?.length) blocks.push({ type: "blockquote", blocks: quote });
  return blocks;
}

// строки инлайн-клавиатуры становятся рядами кнопок внутри сообщения
function kbToBlocks(kb: Any): Any[] {
  return (kb?.inline_keyboard ?? []).map((row: Any[]) => ({
    type: "buttons",
    buttons: row.map(({ icon_custom_emoji_id: _icon, ...rest }: Any) => rest),
  }));
}

function richMessage(text: string, kb: Any, photo?: string) {
  const blocks: Any[] = [];
  if (photo) blocks.push({ type: "photo", photo: { type: "photo", media: photo } });
  blocks.push(...htmlToBlocks(text), ...kbToBlocks(kb));
  return { blocks };
}

const withoutStyle = (kb: Any) => ({
  inline_keyboard: kb.inline_keyboard.map((row: Any[]) => row.map(({ style: _style, ...rest }: Any) => rest)),
});

async function sendRich(chatId: number, text: string, kb: Any, photo?: string) {
  if (photo) {
    const r = await tgRaw("sendRichMessage", { chat_id: chatId, rich_message: richMessage(text, kb, photo) });
    if (r.ok) return true;
    // логотип внутри сообщения не прошёл: шлём его отдельным фото, а меню с круглыми кнопками уже без картинки
    if (chatId === ADMIN_ID) await say(chatId, `⚠️ Меню с логотипом внутри не отправилось: ${r.description}`);
    await tg("sendPhoto", { chat_id: chatId, photo });
  }
  if (await tg("sendRichMessage", { chat_id: chatId, rich_message: richMessage(text, kb) })) return true;
  return await tg("sendRichMessage", { chat_id: chatId, rich_message: richMessage(text, withoutStyle(kb)) });
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

async function welcome(userId: number) {
  const sub = await getSub(userId);
  let status = "🎁 Подписка: пробный период начнётся при подключении";
  if (sub) {
    const left = new Date(sub.expires_at).getTime() - Date.now();
    status = left > 0
      ? `💎 Подписка: <b>активна</b> · ещё ${fmtMs(left)}`
      : "⌛ Подписка: <b>закончилась</b>";
  }
  return ce("wave", "🌊") + " <b>BlackWave</b>\n<i>тихий страж твоих чатов</i>\n\n" +
    "▫️ Ловлю удалённые и изменённые сообщения\n" +
    "▫️ Мут, игры и полезные команды прямо в чате\n\n" +
    `<blockquote>${status}</blockquote>\n\nВыбери раздел 👇`;
}

const mainKb = {
  inline_keyboard: [
    [{ text: "🔌 Подключить", callback_data: "m:connect" }, { text: "📜 Команды", callback_data: "m:cmds" }],
    [{ text: "💎 Подписка", callback_data: "m:sub" }],
    [{ text: "🔒 Политика конфиденциальности", callback_data: "m:policy" }],
  ],
};
const backRow = [backBtn("m:home")];
const closeRow = [{ text: "✖️ Закрыть", callback_data: "h:close", style: "danger" }];

// ---------- каталог команд ----------
type CmdInfo = { icon: string; short: string; usage: string; notes: string[] };
const CMD_INFO: Record<string, CmdInfo> = {
  mute: {
    icon: "🔇", short: "Заглушить собеседника", usage: ".mute",
    notes: [
      "каждое новое сообщение этого человека сразу удаляется",
      "правки его сообщений тоже удаляются",
      "в чате появится «Пользователь замучен» с кнопкой «Размутить», нажать её можешь только ты",
    ],
  },
  unmute: {
    icon: "🔔", short: "Снять мут", usage: ".unmute",
    notes: ["сообщения собеседника больше не удаляются", "то же делает кнопка «Размутить» в чате"],
  },
  nomute: {
    icon: "🛡", short: "Анти-мут", usage: ".nomute",
    notes: [
      "если твоё сообщение удалили сразу после отправки (например, чужой мут-бот), бот отправит его заново один раз",
      "выключить: кнопка «Отключить» или .nomute off",
      "если удалишь своё сообщение в первые 10 секунд, оно тоже отправится снова",
    ],
  },
  noli: {
    icon: "❌", short: "Крестики-нолики с собеседником", usage: ".noli",
    notes: ["первый ход по жребию", "ходите по очереди нажатием на клетки", "после игры есть кнопка «Играть снова»"],
  },
  knb: {
    icon: "✊", short: "Камень, ножницы, бумага", usage: ".knb",
    notes: ["каждый выбирает тайно", "результат показывается, когда выберут оба", "после раунда есть кнопка «Играть снова»"],
  },
  calc: {
    icon: "🧮", short: "Калькулятор", usage: ".calc 2+2*3",
    notes: ["понимает + − × ÷ ^, скобки и десятичные числа", "результат отправляется в чат: 2+2*3 = 8"],
  },
  coin: {
    icon: "🪙", short: "Орёл или решка", usage: ".coin",
    notes: ["бот отправляет в чат случайный результат"],
  },
  type: {
    icon: "⌨️", short: "Текст «печатается» по буквам", usage: ".type привет, как дела",
    notes: ["бот правит твоё сообщение маленькими шагами", "у собеседника оно будет с пометкой «изменено»"],
  },
  help: {
    icon: "📖", short: "Меню команд прямо в чате", usage: ".help",
    notes: [
      "бот отправляет в чат меню со всеми командами",
      "листать его можешь только ты",
      "закрыть меню: кнопка «Закрыть»; работает и .menu",
    ],
  },
  spam: {
    icon: "📨", short: "Повторить фразу N раз", usage: ".spam 5 привет",
    notes: [
      "N от 1 до 99, между сообщениями пауза около 0,7 секунды",
      "остановить рассылку нельзя, пока она не закончится",
      "Telegram может ограничить аккаунт за массовые одинаковые сообщения",
    ],
  },
};
const CMD_GROUPS: Record<string, { icon: string; title: string; cmds: string[] }> = {
  ctl: { icon: "🧹", title: "Управление", cmds: ["mute", "unmute", "nomute"] },
  games: { icon: "🎮", title: "Игры", cmds: ["noli", "knb"] },
  tools: { icon: "🧰", title: "Утилиты", cmds: ["calc", "coin", "type", "help", "spam"] },
};

const isHelpText = (t: string) =>
  t.startsWith("📜 Команды\n") ||
  Object.values(CMD_GROUPS).some((g) => t.startsWith(`${g.icon} ${g.title}\n`)) ||
  Object.entries(CMD_INFO).some(([n, i]) => t.startsWith(`${i.icon} .${n}\n`));

const chunk = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

function commandsRoot(p = "m") {
  const groups = Object.entries(CMD_GROUPS).map(([k, g]) => ({ text: `${g.icon} ${g.title}`, callback_data: `${p}:g:${k}` }));
  return {
    text: ce("cmds", "📜") + " <b>Команды</b>\n\n<blockquote>Выбери раздел, чтобы посмотреть команды. Все они пишутся в чате с собеседником.</blockquote>",
    kb: { inline_keyboard: [...chunk(groups, 2), p === "m" ? backRow : closeRow] },
  };
}

function groupScreen(key: string, p = "m") {
  const g = CMD_GROUPS[key];
  if (!g) return null;
  const buttons = g.cmds.map((c) => ({ text: `.${c}`, callback_data: `${p}:c:${c}` }));
  return {
    text: `${ce(key, g.icon)} <b>${g.title}</b>\n\n<blockquote>Выбери команду ниже, чтобы узнать, как она работает.</blockquote>`,
    kb: { inline_keyboard: [...chunk(buttons, 3), [backBtn(`${p}:cmds`)]] },
  };
}

function commandScreen(name: string, p = "m") {
  const info = CMD_INFO[name];
  const group = Object.entries(CMD_GROUPS).find(([, g]) => g.cmds.includes(name));
  if (!info || !group) return null;
  return {
    text: `${ce("c_" + name, info.icon)} <b>.${name}</b>\n\n<blockquote>${info.short}</blockquote>\n\n` +
      `<b>Как пользоваться</b>\nНапиши в чате: <code>${esc(info.usage)}</code>\n\n` +
      `<b>Что важно</b>\n${info.notes.map((n) => `▫️ ${n}`).join("\n")}`,
    kb: { inline_keyboard: [[backBtn(`${p}:g:${group[0]}`)]] },
  };
}

async function screen(key: string, userId: number): Promise<{ text: string; kb: Any }> {
  if (key.startsWith("g:")) {
    const g = groupScreen(key.slice(2));
    if (g) return g;
  }
  if (key.startsWith("c:")) {
    const c = commandScreen(key.slice(2));
    if (c) return c;
  }
  switch (key) {
    case "connect": {
      const u = await getBotUsername();
      const rows: Any[] = [];
      if (u) rows.push([{ text: `📋 Скопировать @${u}`, copy_text: { text: `@${u}` } }]);
      rows.push([{ text: "⚙️ Открыть настройки", url: "tg://settings" }]);
      rows.push(backRow);
      return {
        text: ce("connect", "🔌") + " <b>Подключение</b>\n\n<blockquote>Займёт меньше минуты</blockquote>\n\n" +
          "1️⃣ Открой настройки → <b>Аккаунт</b>\n" +
          "2️⃣ Выбери <b>Автоматизация чатов</b>\n" +
          `3️⃣ Вставь ${u ? `<code>@${u}</code>` : "имя этого бота"} и подтверди\n` +
          "4️⃣ Выдай доступ к чатам и права на удаление сообщений\n\n" +
          "После подключения я напишу «✅ Бот подключён».",
        kb: { inline_keyboard: rows },
      };
    }
    case "cmds":
      return commandsRoot();
    case "sub":
      return await subScreen(userId);
    case "policy":
      return {
        text: ce("policy", "🔒") + " <b>Конфиденциальность</b>\n\n" +
          "<blockquote>Бот работает только в чатах, к которым ты сам дал доступ через Telegram Business.</blockquote>\n\n" +
          "📦 <b>Что хранится:</b> текст сообщений, имя и ID отправителя, ссылки на медиа и время\n" +
          "🎯 <b>Зачем:</b> чтобы показать тебе сообщение, если его удалят или изменят\n" +
          "👁 <b>Кому видно:</b> только владельцу аккаунта\n" +
          "🤝 <b>Третьим лицам:</b> не передаётся (кроме инфраструктуры Telegram и Supabase)\n" +
          "🔇 Сообщения заглушённых через .mute не сохраняются\n\n" +
          "Отключи бота в настройках Telegram, и новые сообщения перестанут сохраняться.",
        kb: { inline_keyboard: [[{ text: "📄 Полная версия", url: POLICY_URL }], backRow] },
      };
    default:
      return { text: await welcome(userId), kb: mainKb };
  }
}

async function showMenu(chatId: number) {
  const text = await welcome(chatId); // в личке с ботом id чата совпадает с id пользователя
  if (RICH_MENU && (await sendRich(chatId, text, mainKb, MENU_IMAGE))) return;
  const ok = await tg("sendPhoto", {
    chat_id: chatId,
    photo: MENU_IMAGE,
    caption: text,
    parse_mode: "HTML",
    reply_markup: mainKb,
  });
  // если картинка не загрузилась, показываем меню без неё
  if (!ok) await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: mainKb });
}

async function onMenuCallback(q: Any) {
  const { text, kb } = await screen(String(q.data).slice(2), q.from.id);
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  const msg = q.message;
  if (!msg) return;
  if (RICH_MENU) {
    const photo = String(q.data).slice(2) === "home" ? MENU_IMAGE : undefined; // логотип только на главном экране
    const isRich = !!msg.rich_message || (!msg.text && !msg.photo);
    if (isRich) {
      const variants: Any[] = [];
      if (photo) variants.push(richMessage(text, kb, photo));
      variants.push(richMessage(text, kb), richMessage(text, withoutStyle(kb)));
      for (const rich_message of variants) {
        if (await tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, rich_message })) return;
      }
      return;
    }
    // старое меню (фото или обычный текст): показываем новый экран, старое фото-меню убираем
    if (await sendRich(msg.chat.id, text, kb, photo)) {
      if (msg.photo) await tg("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
      return;
    }
  }
  const edit = (markup: Any) => {
    const common = { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: "HTML", reply_markup: markup };
    return msg.photo ? tg("editMessageCaption", { ...common, caption: text }) : tg("editMessageText", { ...common, text });
  };
  if (await edit(kb)) return;
  // если Telegram не принял оформление кнопок, пробуем без цвета, затем без кнопок-ссылок
  const noStyle = {
    inline_keyboard: kb.inline_keyboard.map((row: Any[]) => row.map(({ style: _style, icon_custom_emoji_id: _icon, ...rest }: Any) => rest)),
  };
  if (await edit(noStyle)) return;
  const plain = {
    inline_keyboard: noStyle.inline_keyboard
      .map((row: Any[]) => row.filter((b) => !b.url && !b.copy_text))
      .filter((row: Any[]) => row.length),
  };
  await edit(plain);
}

// удаление с повторами: если Telegram не принял запрос с первого раза, пробуем ещё
async function deleteHard(connId: string, ids: number[]) {
  for (let i = 0; i < 3; i++) {
    if (await tg("deleteBusinessMessages", { business_connection_id: connId, message_ids: ids })) return true;
    await sleep(300 * (i + 1));
  }
  console.error("deleteHard failed", connId, ids);
  return false;
}

// ---------- анти-мут (.nomute) ----------
// Если твоё сообщение удалили почти сразу после отправки (например, чужой мут-бот), бот отправляет его заново один раз.
const ANTI_MUTE_WINDOW_MS = 10_000;
const isCommandText = (t: string) =>
  CMD.test(t) || SPAM.test(t) || NOLI.test(t) || NOMUTE.test(t) || COIN.test(t) || TYPE.test(t) || CALC.test(t) || RPS.test(t) || HELP.test(t);
// служебные сообщения бота: анимация .type, игра, уведомления. Их правки и удаления никому не показываем
const isServiceText = (t: string) =>
  t.startsWith(NOTICE) || t.startsWith("🎮 Крестики-нолики") || t.startsWith("🛡 Анти-мут") || t.startsWith(RPS_TITLE) || isHelpText(t) || TYPE.test(t);

async function isAntiMute(connId: string, chatId: number) {
  const { data } = await db.from("antimute_chats").select("chat_id").eq("conn_id", connId).eq("chat_id", chatId).maybeSingle();
  return !!data;
}

async function resendOwn(connId: string, chatId: number, r: Any) {
  const map: Record<string, [string, string]> = {
    photo: ["sendPhoto", "photo"],
    video: ["sendVideo", "video"],
    voice: ["sendVoice", "voice"],
    audio: ["sendAudio", "audio"],
    document: ["sendDocument", "document"],
    animation: ["sendAnimation", "animation"],
    video_note: ["sendVideoNote", "video_note"],
    sticker: ["sendSticker", "sticker"],
  };
  if (r.media_type && r.file_id && map[r.media_type]) {
    const [method, field] = map[r.media_type];
    const body: Any = { business_connection_id: connId, chat_id: chatId, [field]: r.file_id };
    if (r.text && r.media_type !== "video_note" && r.media_type !== "sticker") body.caption = r.text;
    return tg(method, body);
  }
  return tg("sendMessage", { business_connection_id: connId, chat_id: chatId, text: r.text });
}

async function restoreOwn(e: Any, owner: { owner_user_id: number }) {
  const { data: rows } = await db.from("messages").select("*")
    .eq("conn_id", e.business_connection_id).eq("chat_id", e.chat.id)
    .eq("from_id", owner.owner_user_id).in("msg_id", e.message_ids);
  const done: number[] = [];
  for (const r of (rows ?? []) as Any[]) {
    const text = (r.text ?? "").trim();
    if (isCommandText(text)) continue; // свои команды бот удаляет сам
    if (!text && !r.file_id) continue;
    if (Date.now() - new Date(r.created_at).getTime() > ANTI_MUTE_WINDOW_MS) continue; // удалено не сразу
    await resendOwn(e.business_connection_id, e.chat.id, r);
    done.push(r.msg_id);
  }
  // повторно отправленное сообщение бот не отслеживает, поэтому цикла не будет
  if (done.length) {
    await db.from("messages").delete()
      .eq("conn_id", e.business_connection_id).eq("chat_id", e.chat.id).in("msg_id", done);
  }
}

async function onAntiMute(m: Any, enable: boolean) {
  const connId = m.business_connection_id;
  if (enable) await db.from("antimute_chats").upsert({ conn_id: connId, chat_id: m.chat.id });
  else await db.from("antimute_chats").delete().eq("conn_id", connId).eq("chat_id", m.chat.id);
  await tg("deleteBusinessMessages", { business_connection_id: connId, message_ids: [m.message_id] });
  const payload: Any = {
    business_connection_id: connId,
    chat_id: m.chat.id,
    text: enable ? "🛡 Анти-мут включён" : "🛡 Анти-мут выключен",
  };
  if (enable) payload.reply_markup = { inline_keyboard: [[{ text: "🔕 Отключить", callback_data: "n:off" }]] };
  await tg("sendMessage", payload);
}

async function onAntiMuteCallback(q: Any) {
  const msg = q.message;
  const connId = msg?.business_connection_id;
  if (!msg || !connId) {
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    return;
  }
  const owner = await getOwner(connId);
  if (!owner || owner.owner_user_id !== q.from.id) { // отключить может только тот, кто включил
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Отключить может только тот, кто включил", show_alert: true });
    return;
  }
  await db.from("antimute_chats").delete().eq("conn_id", connId).eq("chat_id", msg.chat.id);
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: "🛡 Анти-мут выключен" });
  await tg("deleteBusinessMessages", { business_connection_id: connId, message_ids: [msg.message_id] });
}

// ---------- .coin, .calc, .type ----------
// безопасный калькулятор без eval: + - * / ^ (или **), скобки, десятичные числа
function calc(src: string): number {
  const s = src.replace(/×/g, "*").replace(/÷/g, "/").replace(/\*\*/g, "^").replace(/,/g, ".").replace(/\s+/g, "");
  let i = 0;
  const bad = () => new Error("bad expression");
  const expr = (): number => {
    let v = term();
    while (s[i] === "+" || s[i] === "-") {
      const op = s[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (s[i] === "*" || s[i] === "/") {
      const op = s[i++];
      const r = unary();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const unary = (): number => {
    if (s[i] === "-") { i++; return -unary(); }
    if (s[i] === "+") { i++; return unary(); }
    return power();
  };
  const power = (): number => {
    const base = atom();
    if (s[i] === "^") { i++; return Math.pow(base, unary()); }
    return base;
  };
  const atom = (): number => {
    if (s[i] === "(") {
      i++;
      const v = expr();
      if (s[i] !== ")") throw bad();
      i++;
      return v;
    }
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) throw bad();
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const v = expr();
  if (i !== s.length || !Number.isFinite(v)) throw bad();
  return v;
}

async function onCoin(m: Any) {
  const connId = m.business_connection_id;
  await deleteHard(connId, [m.message_id]);
  const text = Math.random() < 0.5 ? "🪙 Орёл" : "🪙 Решка";
  await tg("sendMessage", { business_connection_id: connId, chat_id: m.chat.id, text });
}

async function onCalc(m: Any, src: string) {
  const connId = m.business_connection_id;
  const expression = src.trim();
  await deleteHard(connId, [m.message_id]);
  let result: string;
  try {
    const v = calc(expression);
    result = Math.abs(v) < 1e15 ? String(Math.round(v * 1e10) / 1e10) : String(v);
  } catch {
    await tg("sendMessage", {
      business_connection_id: connId,
      chat_id: m.chat.id,
      text: `⚠️ Не смог посчитать: ${expression.slice(0, 100)}\nПример: .calc 2+2*3`,
    });
    return;
  }
  await tg("sendMessage", { business_connection_id: connId, chat_id: m.chat.id, text: `${expression} = ${result}` });
}

// текст «печатается»: правим твоё же сообщение маленькими шагами
async function runType(connId: string, chatId: number, msgId: number, text: string) {
  const chars = Array.from(text);
  const steps = chars.length > 500 ? 1 : Math.min(12, chars.length);
  const size = Math.ceil(chars.length / steps);
  const edit = (t: string) =>
    tg("editMessageText", { business_connection_id: connId, chat_id: chatId, message_id: msgId, text: t });
  for (let k = 1; k <= steps; k++) {
    const shown = Math.min(chars.length, k * size);
    const last = shown >= chars.length;
    const ok = await edit(chars.slice(0, shown).join("") + (last ? "" : "▌"));
    if (!ok) {
      if (k === 1) { // править нельзя: убираем команду и отправляем текст целиком
        await deleteHard(connId, [msgId]);
        await tg("sendMessage", { business_connection_id: connId, chat_id: chatId, text });
      } else { // сбой посередине: пробуем один раз показать итоговый текст
        await sleep(1500);
        await edit(text);
      }
      return;
    }
    if (!last) await sleep(600);
  }
}

async function onType(m: Any, text: string) {
  const job = runType(m.business_connection_id, m.chat.id, m.message_id, text);
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(job);
  else await job;
}

// ---------- камень, ножницы, бумага (.knb) ----------
// Выборы игроков хранятся в таблице rps_games, пока оба не выберут. Потом показываем результат.
const RPS_NAME: Record<string, string> = { R: "✊ Камень", P: "✋ Бумага", S: "✌️ Ножницы" };
const RPS_BEATS: Record<string, string> = { R: "S", S: "P", P: "R" }; // что побеждает ключ

function rpsRender(ownerNm: string, partnerNm: string, op: string | null, pp: string | null, reveal = false) {
  if (!reveal) {
    return {
      text: `<b>${RPS_TITLE}</b>\n\n👤 ${esc(ownerNm)} — ${op ? "✅ выбрал" : "⏳ думает"}\n👤 ${esc(partnerNm)} — ${pp ? "✅ выбрал" : "⏳ думает"}\n\n<blockquote>Выбор скрыт, пока не выберут оба</blockquote>`,
      kb: {
        inline_keyboard: [[
          { text: "✊ Камень", callback_data: "k:R" },
          { text: "✌️ Ножницы", callback_data: "k:S" },
          { text: "✋ Бумага", callback_data: "k:P" },
        ]],
      },
    };
  }
  const status = op === pp
    ? "🤝 Ничья!"
    : `🏆 Победил ${esc(RPS_BEATS[op!] === pp ? ownerNm : partnerNm)}!`;
  return {
    text: `<b>${RPS_TITLE}</b>\n\n👤 ${esc(ownerNm)} — ${RPS_NAME[op!]}\n👤 ${esc(partnerNm)} — ${RPS_NAME[pp!]}\n\n<blockquote>${status}</blockquote>`,
    kb: { inline_keyboard: [[{ text: "🔄 Играть снова", callback_data: "k:again" }]] },
  };
}

async function startRps(m: Any) {
  const connId = m.business_connection_id;
  await deleteHard(connId, [m.message_id]);
  const g = rpsRender(fullName(m.from), chatName(m.chat), null, null);
  await tg("sendMessage", {
    business_connection_id: connId,
    chat_id: m.chat.id,
    text: g.text,
    parse_mode: "HTML",
    reply_markup: g.kb,
  });
}

async function onRpsCallback(q: Any) {
  const answer = (text?: string) => tg("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) });
  const msg = q.message;
  const connId = msg?.business_connection_id;
  if (!msg || !connId) return void await answer();
  const owner = await getOwner(connId);
  if (!owner) return void await answer();

  const ownerId = owner.owner_user_id;
  if (q.from.id !== ownerId && q.from.id !== msg.chat.id) return void await answer("Это игра не для тебя");
  const isOwner = q.from.id === ownerId;
  const ownerNm = isOwner ? fullName(q.from) : await userName(ownerId);
  const partnerNm = isOwner ? chatName(msg.chat) : fullName(q.from);
  const key = { conn_id: connId, chat_id: msg.chat.id, msg_id: msg.message_id };
  const edit = (g: { text: string; kb: Any }) =>
    tg("editMessageText", {
      business_connection_id: connId,
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      text: g.text,
      parse_mode: "HTML",
      reply_markup: g.kb,
    });

  const choice = String(q.data).split(":")[1];
  if (choice === "again") { // новый раунд
    await db.from("rps_games").delete().match(key);
    await answer();
    await edit(rpsRender(ownerNm, partnerNm, null, null));
    return;
  }
  if (!RPS_NAME[choice]) return void await answer();

  // запись игры создаём при первом выборе, свой выбор записываем только если он ещё пуст
  await db.from("rps_games").upsert(key, { onConflict: "conn_id,chat_id,msg_id", ignoreDuplicates: true });
  const col = isOwner ? "owner_pick" : "partner_pick";
  const { data: upd } = await db.from("rps_games").update({ [col]: choice }).match(key).is(col, null).select();
  if (!upd?.length) return void await answer("Ты уже сделал выбор");
  await answer("Выбор принят ✅");

  let row = upd[0] as Any;
  if (!(row.owner_pick && row.partner_pick)) {
    await edit(rpsRender(ownerNm, partnerNm, row.owner_pick, row.partner_pick));
    // второй игрок мог выбрать почти одновременно: перепроверяем
    await sleep(400);
    const { data: fresh } = await db.from("rps_games").select("*").match(key).maybeSingle();
    if (!(fresh?.owner_pick && fresh?.partner_pick)) return;
    row = fresh;
  }
  await edit(rpsRender(ownerNm, partnerNm, row.owner_pick, row.partner_pick, true));
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
  else status = `▶️ Ходит: ${SYM[turn]} ${esc(turn === "X" ? xName : oName)}`;
  return {
    text: `🎮 <b>Крестики-нолики</b>\n\n❌ ${esc(xName)}\n⭕ ${esc(oName)}\n\n<blockquote>${status}</blockquote>`,
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

// ---------- .help: меню команд прямо в чате ----------
async function sendHelp(m: Any) {
  const connId = m.business_connection_id;
  await deleteHard(connId, [m.message_id]);
  const g = commandsRoot("h");
  await tg("sendMessage", {
    business_connection_id: connId,
    chat_id: m.chat.id,
    text: g.text,
    parse_mode: "HTML",
    reply_markup: g.kb,
  });
}

async function onHelpCallback(q: Any) {
  const answer = (text?: string, alert = false) =>
    tg("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) });
  const msg = q.message;
  const connId = msg?.business_connection_id;
  if (!msg || !connId) return void await answer();
  const owner = await getOwner(connId);
  if (!owner || owner.owner_user_id !== q.from.id) return void await answer("Это меню не для тебя", true);

  const key = String(q.data).slice(2);
  if (key === "close") {
    await answer();
    await deleteHard(connId, [msg.message_id]);
    return;
  }
  const g = key === "cmds"
    ? commandsRoot("h")
    : key.startsWith("g:")
    ? groupScreen(key.slice(2), "h")
    : key.startsWith("c:")
    ? commandScreen(key.slice(2), "h")
    : null;
  if (!g) return void await answer();
  await answer();
  const edit = (kb: Any) =>
    tg("editMessageText", {
      business_connection_id: connId,
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      text: g.text,
      parse_mode: "HTML",
      reply_markup: kb,
    });
  if (await edit(g.kb)) return;
  // если Telegram не принял цвет или иконки кнопок, пробуем без них
  await edit({
    inline_keyboard: g.kb.inline_keyboard.map((row: Any[]) =>
      row.map(({ style: _style, icon_custom_emoji_id: _icon, ...rest }: Any) => rest)
    ),
  });
}

// администратор отправляет боту премиум-эмодзи, бот отвечает их ID
async function onEmojiIds(m: Any) {
  const text: string = m.text ?? "";
  const lines = (m.entities ?? [])
    .filter((x: Any) => x.type === "custom_emoji")
    .map((x: Any) => `${text.slice(x.offset, x.offset + x.length)} — <code>${x.custom_emoji_id}</code>`);
  await tg("sendMessage", {
    chat_id: m.chat.id,
    parse_mode: "HTML",
    text: `🆔 <b>ID премиум-эмодзи</b>\n\n${lines.join("\n")}\n\n<i>Нажми на ID, чтобы скопировать</i>`,
  });
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
    else if (u.message?.from?.id === ADMIN_ID && u.message.entities?.some((x: Any) => x.type === "custom_emoji")) {
      await onEmojiIds(u.message);
    }
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
