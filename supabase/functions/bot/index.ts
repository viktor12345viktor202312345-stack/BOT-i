// Telegram-бот: присылает в ЛС удалённые и изменённые сообщения (Business API).
// Команды владельца в чате: .mute (каждое сообщение собеседника сразу удаляется) и .unmute (вернуть).
import { createClient } from "npm:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("BOT_TOKEN")!;
const SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const IGNORE_OWN = (Deno.env.get("IGNORE_OWN") ?? "1") === "1";
const API = `https://api.telegram.org/bot${TOKEN}`;
const CMD = /^\.(mute|unmute)$/i;

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

  let text = mute
    ? `🔇 Заглушен: ${esc(chatName(m.chat))}\nКаждое новое сообщение собеседника будет удаляться автоматически. Вернуть: .unmute`
    : `🔔 Включён: ${esc(chatName(m.chat))}\nСообщения собеседника больше не удаляются.`;
  if (!removed) {
    text += "\n\n⚠️ Не удалось удалить команду из чата. Включи боту право удалять сообщения: " +
      "Настройки → Telegram для бизнеса → Чат-боты → твой бот. Без него автоудаление тоже не сработает.";
  }
  await tg("sendMessage", { chat_id: owner.owner_chat_id, parse_mode: "HTML", text });
}

async function onEdited(m: Any) {
  const owner = await getOwner(m.business_connection_id);
  if (!owner) return;
  const { data: old } = await db.from("messages").select("text")
    .eq("conn_id", m.business_connection_id).eq("chat_id", m.chat.id)
    .eq("msg_id", m.message_id).maybeSingle();
  const oldText = old ? old.text : "(не сохранено — сообщение было до подключения бота)";
  const newText = m.text ?? m.caption ?? "";
  const fromOwner = m.from?.id === owner.owner_user_id;
  if (!fromOwner && await isMuted(m.business_connection_id, m.chat.id)) return;
  await saveMessage(m);
  if (IGNORE_OWN && fromOwner) return;
  if (old && old.text === newText) return;
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
    if (!r) {
      await tg("sendMessage", {
        chat_id: owner.owner_chat_id,
        parse_mode: "HTML",
        text: `🗑 <b>Удалено сообщение</b> в чате ${esc(chatName(e.chat))}\n(содержимое неизвестно — оно пришло до подключения бота)`,
      });
      continue;
    }
    if (CMD.test((r.text ?? "").trim())) continue; // удалённая команда .mute/.unmute
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
    else if (u.message?.text === "/start") {
      await tg("sendMessage", {
        chat_id: u.message.chat.id,
        text: "Подключи меня: Настройки → Telegram для бизнеса → Чат-боты, выбери этого бота и дай доступ к чатам.",
      });
    }
  } catch (err) {
    console.error(err);
  }
  return new Response("ok"); // всегда 200, чтобы Telegram не слал повторы
});
