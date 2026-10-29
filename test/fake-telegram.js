/** 本地的假 Telegram Bot API：记录所有调用，方便断言机器人行为。 */

const OBJECT_PARAMS = [
  'reply_markup',
  'link_preview_options',
  'media',
  'reply_parameters',
  'reaction',
  'allowed_updates',
  'commands',
  'options',
];

function normalizeParams(raw) {
  const params = { ...raw };
  for (const key of OBJECT_PARAMS) {
    if (typeof params[key] === 'string') {
      try {
        params[key] = JSON.parse(params[key]);
      } catch {
        /* 保持原样 */
      }
    }
  }
  return params;
}

/**
 * 网页投稿走 multipart 上传：把 FormData 摊平成参数，文件本身记成占位对象。
 *
 * `file` 字段保留原始 Blob：后台审核要能取回附件字节，假 Telegram 必须真的
 * 存得下内容，否则「取图」这条链只能测到 404。
 */
function parseBody(init) {
  if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
    const params = {};
    for (const [key, value] of init.body.entries()) {
      params[key] =
        typeof value === 'string'
          ? value
          : {
              __upload: true,
              name: value.name ?? 'file',
              size: value.size ?? 0,
              type: value.type ?? '',
              file: value,
            };
    }
    return params;
  }
  return normalizeParams(JSON.parse(init.body ?? '{}'));
}

function uploadOf(value) {
  return value && typeof value === 'object' && value.__upload === true ? value : null;
}

/** 登记一份上传内容，返回 file_id。getFile 和下载都从这里查。 */
function rememberMediaInto(state, fileId, upload, folder, extension) {
  const path = `${folder}/${fileId}${extension}`;
  state.media[fileId] = {
    file: upload.file,
    name: upload.name,
    type: upload.type,
    size: upload.size,
    path,
  };
  state.mediaByPath[path] = state.media[fileId];
  return fileId;
}

function ok(result) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export function createFakeTelegram({
  chatUsername = 'test_group',
  failures = {},
  linkedChatId = null,
  botMemberStatus = 'administrator',
  chatType = 'supergroup',
  isForum = false,
} = {}) {
  const state = {
    calls: [],
    /** file_id → { file, name, type }，getFile + 下载都靠它。 */
    media: {},
    /** file_path → media 条目，模拟 /file/bot<token>/<path> 这条真实下载地址。 */
    mediaByPath: {},
    messages: [],
    edits: [],
    mediaEdits: [],
    deletions: [],
    reactions: [],
    pins: [],
    nextMessageId: 1000,
  };

  const rememberMedia = (fileId, upload, folder, extension) =>
    rememberMediaInto(state, fileId, upload, folder, extension);

  async function fetchImpl(url, init = {}) {
    /* Bot API 的文件下载不是 /bot<token>/<method>，而是 /file/bot<token>/<path>。
     * 它必须回字节，不能落进下面那套 JSON 分派里。 */
    const urlString = String(url);
    if (urlString.includes('/file/bot')) {
      const filePath = urlString.split('/file/bot')[1].split('/').slice(1).join('/');
      const entry = state.mediaByPath[filePath];
      if (!entry?.file) return new Response('not found', { status: 404 });
      const bytes = new Uint8Array(await entry.file.arrayBuffer());
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': entry.type || 'application/octet-stream',
          'content-length': String(bytes.length),
        },
      });
    }

    const method = String(url).split('/').pop();
    const params = parseBody(init);
    state.calls.push({ method, params });

    const failure = failures[method]?.(params);
    if (failure) {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: failure }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    switch (method) {
      case 'sendMessage': {
        const message = {
          message_id: ++state.nextMessageId,
          chat: { id: Number(params.chat_id) },
          text: params.text,
          keyboard: params.reply_markup ?? null,
          reply_to: params.reply_parameters?.message_id ?? null,
          threadId: params.message_thread_id ?? null,
        };
        state.messages.push(message);
        return ok(message);
      }
      case 'sendPhoto': {
        const upload = uploadOf(params.photo);
        const message = {
          message_id: ++state.nextMessageId,
          chat: { id: Number(params.chat_id) },
          caption: params.caption,
          photo: upload
            ? [
                {
                  file_id: rememberMedia(`uploaded-photo-${state.nextMessageId}`, upload, 'photos', '.jpg'),
                  file_unique_id: `uniq-${state.nextMessageId}`,
                  width: 1280,
                  height: 720,
                },
              ]
            : params.photo,
          keyboard: params.reply_markup ?? null,
          threadId: params.message_thread_id ?? null,
        };
        state.messages.push(message);
        return ok(message);
      }
      case 'sendVideo':
      case 'sendDocument':
      case 'sendAudio':
      case 'sendVoice': {
        const kind = method.replace('send', '').toLowerCase();
        const upload = uploadOf(params[kind]);
        const file = upload
          ? {
              file_id: rememberMedia(
                `uploaded-${kind}-${state.nextMessageId + 1}`,
                upload,
                'documents',
                kind === 'video' ? '.mp4' : '.bin',
              ),
              file_unique_id: `uniq-${state.nextMessageId + 1}`,
              file_name: upload.name,
            }
          : params[kind];
        const message = {
          message_id: ++state.nextMessageId,
          chat: { id: Number(params.chat_id) },
          kind,
          file,
          caption: params.caption ?? null,
          threadId: params.message_thread_id ?? null,
        };
        if (upload) message[kind] = file;
        state.messages.push(message);
        return ok(message);
      }
      case 'sendPoll': {
        const message = {
          message_id: ++state.nextMessageId,
          chat: { id: Number(params.chat_id) },
          kind: 'poll',
          poll: { question: params.question, options: params.options },
          threadId: params.message_thread_id ?? null,
        };
        state.messages.push(message);
        return ok(message);
      }
      case 'sendLocation': {
        const message = {
          message_id: ++state.nextMessageId,
          chat: { id: Number(params.chat_id) },
          kind: 'location',
          location: { latitude: params.latitude, longitude: params.longitude },
          threadId: params.message_thread_id ?? null,
        };
        state.messages.push(message);
        return ok(message);
      }
      case 'sendMediaGroup': {
        const group = params.media.map((item, index) => ({
          message_id: ++state.nextMessageId,
          chat: { id: Number(params.chat_id) },
          caption: item.caption ?? null,
          photo: item.media,
          threadId: params.message_thread_id ?? null,
          index,
        }));
        state.messages.push(...group);
        return ok(group);
      }
      case 'editMessageText': {
        state.edits.push({ chatId: Number(params.chat_id), messageId: params.message_id, text: params.text });
        const target = state.messages.find((m) => m.message_id === params.message_id);
        if (target) {
          target.text = params.text;
          target.keyboard = params.reply_markup ?? null;
        }
        return ok(target ?? true);
      }
      case 'editMessageMedia': {
        const media = params.media ?? {};
        state.mediaEdits.push({
          chatId: Number(params.chat_id),
          messageId: params.message_id,
          type: media.type,
          media: media.media,
          caption: media.caption ?? null,
        });
        const target = state.messages.find((m) => m.message_id === params.message_id);
        if (target) {
          target.photo = media.media;
          if (media.caption !== undefined) target.caption = media.caption;
        }
        return ok(target ?? true);
      }
      case 'deleteMessage':
        state.deletions.push({ chatId: Number(params.chat_id), messageId: params.message_id });
        return ok(true);
      case 'setMessageReaction':
        state.reactions.push({
          chatId: Number(params.chat_id),
          messageId: params.message_id,
          emoji: params.reaction?.[0]?.emoji ?? null,
        });
        return ok(true);
      case 'pinChatMessage':
        state.pins.push({ chatId: Number(params.chat_id), messageId: params.message_id });
        return ok(true);
      case 'unpinChatMessage':
        state.pins.push({ chatId: Number(params.chat_id), messageId: params.message_id, unpinned: true });
        return ok(true);
      case 'reopenForumTopic':
      case 'reopenGeneralForumTopic':
        return ok(true);
      case 'answerCallbackQuery':
        return ok(true);
      case 'getFile': {
        const entry = state.media[params.file_id];
        if (!entry) {
          return new Response(
            JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        return ok({
          file_id: params.file_id,
          file_unique_id: entry.uniqueId,
          file_size: entry.size,
          file_path: entry.path,
        });
      }
      case 'getMe':
        return ok({ id: 42, is_bot: true, username: 'test_bot', first_name: 'Test' });
      case 'getChat':
        return ok({
          id: Number(params.chat_id),
          type: chatType,
          username: chatUsername,
          title: '测试群',
          is_forum: isForum ? true : undefined,
          linked_chat_id: linkedChatId === null ? undefined : Number(linkedChatId),
        });
      case 'getChatMember':
        return ok({ status: botMemberStatus, user: { id: Number(params.user_id), is_bot: true } });
      case 'getChatAdministrators':
        return ok([{ user: { id: 999, is_bot: false, first_name: '管理员', username: 'admin' }, status: 'creator' }]);
      case 'setWebhook':
        return ok(true);
      case 'setMyCommands':
        return ok(true);
      case 'getWebhookInfo':
        return ok({ url: 'https://bot.example/webhook/secret123', has_custom_certificate: false });
      default:
        return ok(true);
    }
  }

  return {
    state,
    fetch: fetchImpl,
    messagesTo(chatId) {
      return state.messages.filter((message) => message.chat.id === Number(chatId));
    },
    lastMessageTo(chatId) {
      const messages = this.messagesTo(chatId);
      return messages[messages.length - 1] ?? null;
    },
    callsOf(method) {
      return state.calls.filter((call) => call.method === method).map((call) => call.params);
    },
  };
}

/** 从一条机器人消息里取某个按钮的 callback_data。 */
export function callbackDataOf(message, index = 0) {
  const rows = message?.keyboard?.inline_keyboard ?? [];
  const flat = rows.flat();
  if (!flat[index]) throw new Error(`第 ${index} 个按钮不存在：${JSON.stringify(rows)}`);
  return flat[index].callback_data;
}

/** 按按钮文字查找 callback_data。 */
export function findButton(message, text) {
  const flat = (message?.keyboard?.inline_keyboard ?? []).flat();
  const button = flat.find((item) => item.text.includes(text));
  if (!button) throw new Error(`没找到按钮「${text}」，实际有：${flat.map((b) => b.text).join(' / ')}`);
  return button.callback_data;
}
