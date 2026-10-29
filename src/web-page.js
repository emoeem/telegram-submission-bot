/** 网页投稿页面（/submit）。纯字符串拼装：不依赖任何外部资源，国内也能直接打开。 */

import { escapeHtml } from './utils.js';

const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#f5f6fa;--card:#fff;--fg:#1b1f24;--muted:#6b7280;--line:#e5e7eb;--brand:#2f6fed;--danger:#d94838}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--card:#1c1f24;--fg:#e8eaed;--muted:#9aa1ab;--line:#2c3138;--brand:#5b8dff;--danger:#ff7b6b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:20px 14px 40px}
main{max-width:640px;margin:0 auto}
h1{font-size:20px;margin:6px 0 4px}
h2{font-size:17px}
.intro{color:var(--muted);font-size:14px;margin:0 0 18px;white-space:pre-wrap}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
.field{margin-bottom:16px}
.field:last-child{margin-bottom:0}
label{display:block;font-weight:600;font-size:15px;margin-bottom:6px}
.req{color:var(--danger);margin-left:2px}
.hint{color:var(--muted);font-size:13px;margin:6px 0 0}
input[type=text],input[type=number],textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font:inherit}
textarea{min-height:140px;resize:vertical}
input[type=file]{width:100%;font-size:14px}
.choices{display:flex;flex-wrap:wrap;gap:8px}
.choices label{display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:8px 14px;font-weight:500;margin:0;cursor:pointer}
.choices input{accent-color:var(--brand)}
button{width:100%;padding:14px;border:0;border-radius:12px;background:var(--brand);color:#fff;font-size:16px;font-weight:600;cursor:pointer}
button[disabled]{opacity:.6;cursor:progress}
.tip{color:var(--muted);font-size:13px;text-align:center;margin:10px 0 0}
.alert{border:1px solid var(--danger);color:var(--danger);border-radius:12px;padding:10px 12px;font-size:14px;margin-bottom:12px;white-space:pre-wrap}
.done{text-align:center}
.done .big{font-size:40px;margin:8px 0}
.done .id{color:var(--muted);font-size:14px}
a{color:var(--brand)}
.linkrow{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px;font-size:14px}
footer{max-width:640px;margin:22px auto 0;color:var(--muted);font-size:13px;text-align:center}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
[hidden]{display:none!important}
.thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.thumb{position:relative;width:78px;height:78px;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:var(--bg)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb .name{position:absolute;bottom:0;left:0;right:0;font-size:10px;text-align:center;background:rgba(0,0,0,.55);color:#fff;padding:1px 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.thumb button{position:absolute;top:2px;right:2px;width:24px;height:24px;padding:0;border-radius:50%;background:rgba(0,0,0,.66);color:#fff;font-size:14px;line-height:1;cursor:pointer}
.dropzone.dragging{outline:2px dashed var(--brand);outline-offset:4px;border-radius:12px}
.count{color:var(--muted);font-size:12px;float:right;font-weight:400}
.bar{padding:4px 0 0}

/* ---- 视觉重做：卡片化 + 分段选择 + 更柔和的层次 ---- */
body{background:radial-gradient(1200px 600px at 50% -10%,color-mix(in srgb,var(--brand) 14%,transparent),transparent),var(--bg);padding:24px 14px calc(32px + env(safe-area-inset-bottom,0px))}
main{max-width:660px}
h1{font-size:24px;letter-spacing:.2px;margin:2px 0 6px}
.intro{font-size:14px;line-height:1.7}
.card{border-radius:18px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 8px 24px -12px rgba(15,23,42,.18)}
label{font-size:14px;letter-spacing:.2px;color:var(--fg)}
input[type=text],input[type=number],input[type=email],textarea{border-radius:12px;background:color-mix(in srgb,var(--bg) 70%,var(--card));transition:border-color .15s,box-shadow .15s}
input:focus,textarea:focus,select:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 22%,transparent)}
.choices{gap:10px}
.choices label{border-radius:12px;padding:10px 16px;background:color-mix(in srgb,var(--bg) 60%,var(--card));transition:.15s}
.choices label:has(input:checked){border-color:var(--brand);background:color-mix(in srgb,var(--brand) 12%,var(--card));color:var(--brand);font-weight:600}
.dropzone{border:1.5px dashed var(--line);border-radius:14px;padding:14px;background:color-mix(in srgb,var(--bg) 55%,var(--card))}
.dropzone.dragging{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 10%,var(--card))}
button{border-radius:14px;box-shadow:0 8px 20px -10px color-mix(in srgb,var(--brand) 70%,transparent)}
button:hover{filter:brightness(1.06)}
/* 提交条必须留在文档流里：position:sticky/fixed 会让它在视口底部悬空，
   把落在最后 68px 的输入框（验证码）整个盖住——手机上一按就命中按钮或
   透明层，表现为「验证码点不动、也打不进数字」。 */
.bar{padding:4px 0 0;margin-top:2px}
.hint{margin-top:8px}
.count{opacity:.85}
.status{border-radius:999px}
footer{margin-top:28px;line-height:1.8}
`;

/** HTML 属性里的转义：escapeHtml 只管 Telegram 的 <> &，属性里还要挡住引号。 */
function attr(value) {
  return escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** 一个步骤 → HTML（字段名固定为 step:<id> / file:<id>）。 */
function renderStep(step, config) {
  const required = step.required !== false;
  const label = escapeHtml(step.label ?? step.id);
  const prompt = escapeHtml(step.prompt ?? '');
  const star = required ? '<span class="req">*</span>' : '';
  const max = Math.min(step.max_length ?? config.options.maxTextLength, config.options.maxTextLength);
  const name = attr(`step:${step.id}`);

  if (step.type === 'choice') {
    const options = (step.options ?? [])
      .map((option, index) => {
        const id = attr(`${step.id}-${index}`);
        return (
          `<label for="${id}"><input type="radio" id="${id}" name="${name}" value="${attr(option)}"` +
          `${required ? ' required' : ''}>${escapeHtml(option)}</label>`
        );
      })
      .join('');
    return `<div class="field"><label>${label}${star}</label><div class="choices">${options}</div><p class="hint">${prompt}</p></div>`;
  }

  if (step.type === 'media') {
    return (
      `<div class="field"><label>${label}${star}</label>` +
      `<div class="dropzone" data-dropzone><input type="file" name="file:${attr(step.id)}" accept="image/*,video/*" multiple data-media></div><div class="thumbs" data-thumbs></div>` +
      `<p class="hint">${prompt}<br>最多 ${config.options.webMaxFiles} 个，每个不超过 ${config.options.webMaxFileMb} MB（图片或视频）。</p></div>`
    );
  }

  const isLong = max > 120;
  const control = isLong
    ? `<textarea name="${name}" maxlength="${max}"${required ? ' required' : ''}></textarea>`
    : `<input type="text" name="${name}" maxlength="${max}"${required ? ' required' : ''}>`;
  return `<div class="field"><label>${label}<span class="count" data-count="${attr(step.id)}"></span>${star}</label>${control}<p class="hint">${prompt}${isLong ? `（最多 ${max} 字）` : ''}</p></div>`;
}

export function renderSubmitPage({ config, template, botUsername = null }) {
  const steps = template.steps
    .map((step) => {
      const condition = step.show_if
        ? ` data-show-if="${attr(JSON.stringify({ step: step.show_if.step, equals: step.show_if.equals ?? '' }))}"`
        : '';
      return `<div class="stepwrap"${condition}>${renderStep(step, config)}</div>`;
    })
    .join('');

  const title = config.options.webTitle || '📮 投稿';
  const intro =
    config.options.webIntro ||
    '在这里直接投稿，不用注册、也不用装 Telegram。\n提交后会先经过管理员审核，通过后才会发布。';
  const tgLink = botUsername
    ? `<a href="https://t.me/${attr(botUsername)}" target="_blank" rel="noopener">用 Telegram 投稿</a>`
    : '';
  const groupLink = config.mainGroupUrl
    ? `<a href="${attr(config.mainGroupUrl)}" target="_blank" rel="noopener">进入投稿主群</a>`
    : '';
  const footerLinks = [groupLink, tgLink].filter(Boolean).join(' · ') || '感谢投稿';
  const boot = JSON.stringify({
    submitUrl: '/api/submit',
    captchaUrl: '/api/submit/captcha',
    captcha: config.options.captcha,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#2f6fed">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="intro">${escapeHtml(intro)}</p>
  <p class="intro" style="margin-top:-10px"><a href="/submit/inbox" id="inbox-entry">📬 我的投稿收件箱</a>（看审核进度、评论和管理员留言）</p>
  <div id="error" class="alert" hidden></div>
  <form id="submit-form" class="card" novalidate>
    ${steps}
    <div class="field"><label>昵称（选填）</label><input type="text" name="nickname" maxlength="32" autocomplete="nickname">
    <p class="hint">署名方式选了「显示我的昵称」时必填；选匿名就不用管它。</p></div>
    <div class="field"><label>邮箱（选填）</label><input type="email" name="email" maxlength="120" autocomplete="email" inputmode="email">
    <p class="hint">留了邮箱，审核结果和新评论会发邮件通知你；不填也能用（收件箱里一样能看到）。</p></div>
    ${
      config.options.captcha
        ? `<div class="field"><label>验证<span class="req">*</span></label>
      <div id="captcha-question" class="hint">正在加载验证题…</div>
      <input type="text" name="captcha" inputmode="numeric" pattern="[0-9]*" maxlength="4" enterkeyhint="done" autocomplete="off" autocorrect="off" spellcheck="false" style="margin-top:6px" required>
      <p class="hint">按上面的算式填结果，防止脚本刷投稿。</p></div>`
        : ''
    }
    <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
    <input type="hidden" name="viewer" id="viewer-input" value="">
    <div class="bar"><button type="submit" id="submit-button">提交投稿</button></div>
    <p class="tip">提交即表示同意内容被公开发布；审核不通过不会发布。</p>
  </form>
  <section id="done" class="card done" hidden>
    <div class="big">✅</div>
    <h2>投稿已收到</h2>
    <p id="done-text" class="id"></p>
    <p class="hint" style="margin-top:12px">把下面这个链接存起来：之后能在这里看评论、回复评论、跟管理员说话。</p>
    <p><a id="inbox-link" href="/submit/inbox">📬 打开我的投稿收件箱</a></p>
    <div class="linkrow">${groupLink}${tgLink}</div>
  </section>
</main>
<footer>${footerLinks}</footer>
<script>window.__SUBMIT__=${boot};</script>
<script>
(function () {
  var cfg = window.__SUBMIT__ || {};
  var form = document.getElementById('submit-form');
  var errorBox = document.getElementById('error');
  var button = document.getElementById('submit-button');
  var done = document.getElementById('done');
  var token = '';
  var VIEWER_KEY = 'webSubmitViewer';
  function viewerToken() {
    var stored = '';
    try { stored = localStorage.getItem(VIEWER_KEY) || ''; } catch (e) { stored = ''; }
    if (!/^[a-f0-9]{16,64}$/i.test(stored)) {
      var bytes = new Uint8Array(16);
      (window.crypto || window.msCrypto).getRandomValues(bytes);
      stored = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      try { localStorage.setItem(VIEWER_KEY, stored); } catch (e) {}
    }
    return stored;
  }
  var viewer = viewerToken();
  var viewerInput = document.getElementById('viewer-input');
  if (viewerInput) viewerInput.value = viewer;
  var inboxLink = document.getElementById('inbox-link');
  if (inboxLink) inboxLink.setAttribute('href', '/submit/inbox?t=' + viewer);
  var inboxEntry = document.getElementById('inbox-entry');
  if (inboxEntry) inboxEntry.setAttribute('href', '/submit/inbox?t=' + viewer);

  function showError(lines) {
    errorBox.textContent = lines.join('\\n');
    errorBox.hidden = lines.length === 0;
    if (lines.length) errorBox.scrollIntoView({ block: 'center' });
  }

  function fieldValue(name) {
    var nodes = form.querySelectorAll('[name="' + name + '"]');
    if (!nodes.length) return '';
    if (nodes[0].type === 'radio') {
      for (var i = 0; i < nodes.length; i += 1) if (nodes[i].checked) return nodes[i].value;
      return '';
    }
    return nodes[0].value;
  }

  // show_if：条件没满足的步骤整块收起来（与机器人提问流程同一套规则）
  function refreshVisibility() {
    var wraps = form.querySelectorAll('.stepwrap[data-show-if]');
    for (var i = 0; i < wraps.length; i += 1) {
      var cond = JSON.parse(wraps[i].getAttribute('data-show-if'));
      var shown = String(fieldValue('step:' + cond.step)) === String(cond.equals);
      wraps[i].hidden = !shown;
      var inputs = wraps[i].querySelectorAll('input,textarea');
      for (var j = 0; j < inputs.length; j += 1) inputs[j].disabled = !shown;
    }
  }

  function loadCaptcha() {
    // 无论 CAPTCHA 开关如何都要取 token：服务端对每次提交都校验 HMAC 签名，
    // CAPTCHA=0 时 /api/submit/captcha 发的是"免答"token。
    // 之前 cfg.captcha=0 直接 return，token 永远是空串 → 提交 100% 403。
    return fetch(cfg.captchaUrl, { credentials: 'omit' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        token = data.token || '';
        var node = document.getElementById('captcha-question');
        if (node) node.textContent = data.question ? '请算一下：' + data.question : '验证已就绪';
        // 换题之后旧答案就没意义了，留着只会让人以为"我填过了"
        var input = form.querySelector('input[name="captcha"]');
        if (input) input.value = '';
      })
      .catch(function () {
        // 拿不到 token 提交必然失败，必须报出来而不是静默
        showError(['验证加载失败，请刷新页面重试。']);
      });
  }

  // 验证码输入框：移动端键盘可能是数字键盘，也可能带出全角数字/空格，
  // 统一收敛成半角数字，避免"看起来填了但一直验证不过"。
  var captchaInput = form.querySelector('input[name="captcha"]');
  if (captchaInput) {
    captchaInput.addEventListener('input', function () {
      var digits = captchaInput.value
        .replace(/[\uFF10-\uFF19]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xfee0); })
        .replace(/[^0-9]/g, '');
      if (digits !== captchaInput.value) captchaInput.value = digits;
    });
    // 聚焦时把输入框滚到可视区中间：软键盘弹起后它常常正好卡在屏幕底部。
    captchaInput.addEventListener('focus', function () {
      window.setTimeout(function () {
        captchaInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 250);
    });
  }

  function clientValidation() {
    var problems = [];
    var wraps = form.querySelectorAll('.stepwrap');
    for (var i = 0; i < wraps.length; i += 1) {
      if (wraps[i].hidden) continue;
      var required = wraps[i].querySelectorAll('[required]');
      if (!required.length) continue;
      var control = required[0];
      var labelNode = control.closest('.field') && control.closest('.field').querySelector('label');
      var label = labelNode ? labelNode.textContent : '必填项';
      if (control.type === 'radio') {
        if (!fieldValue(control.name)) problems.push(label + '：请选择');
      } else if (!String(control.value || '').trim()) {
        problems.push(label + '：请填写');
      }
    }
    return problems;
  }

  form.addEventListener('change', refreshVisibility);
  form.addEventListener('input', refreshVisibility);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    showError([]);
    refreshVisibility();
    var problems = clientValidation();
    if (problems.length > 0) return showError(problems);

    var data = new FormData(form);
    data.append('token', token);
    button.disabled = true;
    button.textContent = '正在上传…';

    fetch(cfg.submitUrl, { method: 'POST', body: data, credentials: 'omit' })
      .then(function (response) {
        return response.json().then(function (body) { return { status: response.status, body: body || {} }; });
      })
      .then(function (result) {
        var body = result.body;
        if (!body.ok) {
          var lines = body.errors ? Object.keys(body.errors).map(function (key) { return body.errors[key]; }) : [];
          if (body.error) lines.unshift(body.error);
          showError(lines.length ? lines : ['提交失败，请稍后再试。']);
          button.disabled = false;
          button.textContent = '提交投稿';
          if (result.status === 429 || result.status === 403 || result.status === 409) loadCaptcha();
          return;
        }
        form.hidden = true;
        done.hidden = false;
        document.getElementById('done-text').textContent =
          body.status === 'published'
            ? '编号 #' + body.id + ' 已发布，多谢投稿！'
            : '编号 #' + body.id + ' 已收到，管理员审核通过后会发布。';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch(function () {
        showError(['网络不太顺畅，请稍后再试。']);
        button.disabled = false;
        button.textContent = '提交投稿';
      });
  });

  var mediaInput = form.querySelector('[data-media]');
  var thumbBox = form.querySelector('[data-thumbs]');
  var dropzone = form.querySelector('[data-dropzone]');
  function renderThumbs() {
    if (!thumbBox || !mediaInput) return;
    var files = Array.prototype.slice.call(mediaInput.files || []);
    thumbBox.innerHTML = '';
    files.forEach(function (file, index) {
      var cell = document.createElement('div');
      cell.className = 'thumb';
      if (file.type.indexOf('image/') === 0) {
        var img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        cell.appendChild(img);
      }
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = file.name;
      cell.appendChild(name);
      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.title = '移除这个文件';
      del.addEventListener('click', function () { removeFile(index); });
      cell.appendChild(del);
      thumbBox.appendChild(cell);
    });
  }
  function removeFile(index) {
    var list = Array.prototype.slice.call(mediaInput.files || []);
    list.splice(index, 1);
    var transfer = new DataTransfer();
    list.forEach(function (file) { transfer.items.add(file); });
    mediaInput.files = transfer.files;
    renderThumbs();
  }
  function acceptDropped(list) {
    if (!mediaInput || !list || !list.length) return;
    var transfer = new DataTransfer();
    var merged = Array.prototype.slice.call(mediaInput.files || []).concat(Array.prototype.slice.call(list));
    merged.slice(0, cfg.maxFiles || 6).forEach(function (file) {
      if ((file.size || 0) / 1024 / 1024 <= (cfg.maxFileMb || 10)) transfer.items.add(file);
    });
    mediaInput.files = transfer.files;
    renderThumbs();
  }
  if (mediaInput) {
    mediaInput.addEventListener('change', renderThumbs);
    if (dropzone) {
      ['dragenter', 'dragover'].forEach(function (n) {
        dropzone.addEventListener(n, function (e) { e.preventDefault(); dropzone.classList.add('dragging'); });
      });
      ['dragleave', 'drop'].forEach(function (n) {
        dropzone.addEventListener(n, function (e) { e.preventDefault(); dropzone.classList.remove('dragging'); });
      });
      dropzone.addEventListener('drop', function (e) {
        var dropped = e.dataTransfer && e.dataTransfer.files;
        if (dropped && dropped.length) acceptDropped(dropped);
      });
    }
  }
  function refreshCounters() {
    var counters = form.querySelectorAll('[data-count]');
    for (var i = 0; i < counters.length; i += 1) {
      var id = counters[i].getAttribute('data-count');
      var node = form.querySelector('[name="step:' + id + '"]');
      if (!node) continue;
      var max = Number(node.getAttribute('maxlength') || 0);
      counters[i].textContent = node.value.length + (max ? '/' + max : '') + ' 字';
    }
  }
  form.addEventListener('input', refreshCounters);

  refreshVisibility();
  refreshCounters();
  renderThumbs();
  loadCaptcha();
})();
</script>
</body>
</html>`;
}

/** 投稿者收件箱：审核进度 + 评论与回复 + 与管理员的匿名对话。 */
export function renderInboxPage({ config: _config } = {}) {
  const boot = JSON.stringify({
    inboxUrl: '/api/submit/inbox',
    replyUrl: '/api/submit/reply',
    messageUrl: '/api/submit/message',
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#2f6fed">
<title>📬 我的投稿</title>
<style>${PAGE_CSS}
.item{border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:12px;background:var(--card)}
.meta{color:var(--muted);font-size:12px;margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.badge{display:inline-block;padding:1px 7px;border-radius:999px;background:var(--brand);color:#fff;font-size:12px}
.status{padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line);color:var(--muted)}
.comment{border-top:1px solid var(--line);padding:8px 0 0;margin-top:8px;font-size:14px}
.comment.mine{background:var(--bg);border-radius:8px;padding:8px;border-top:0}
.comment .who{font-weight:600;font-size:13px}
.comment .when{color:var(--muted);font-size:12px;font-weight:400;margin-left:6px}
.link{background:none;border:0;color:var(--brand);padding:0;width:auto;font-size:13px;cursor:pointer;margin-top:6px}
.thread{background:var(--bg);border-radius:10px;padding:10px;margin-top:8px}
.thread .msg{margin:6px 0;font-size:14px}
.thread .to_admin{text-align:right;color:var(--brand)}
.row{display:flex;gap:8px;margin-top:8px}
.row textarea{flex:1;min-height:44px;padding:8px 10px}
.row button{width:auto;padding:9px 14px;font-size:14px}
.empty{color:var(--muted);text-align:center;padding:22px 0}
h3{margin:0 0 4px;font-size:15px}
</style>
</head>
<body>
<main>
  <h1>📬 我的投稿</h1>
  <p class="intro">这里能看到你投过的稿、审核进度、别人的评论（可直接回复）和管理员留言。</p>
  <div id="error" class="alert" hidden></div>
  <div id="content"><p class="empty">正在加载…</p></div>
  <p class="tip"><a href="/submit">← 再投一稿</a></p>
</main>
<script>window.__INBOX__=${boot};</script>
<script>
(function () {
  var cfg = window.__INBOX__ || {};
  var content = document.getElementById('content');
  var errorBox = document.getElementById('error');
  var VIEWER_KEY = 'webSubmitViewer';
  function viewer() {
    var fromUrl = new URLSearchParams(location.search).get('t');
    if (/^[a-f0-9]{16,64}$/i.test(fromUrl || '')) {
      try { localStorage.setItem(VIEWER_KEY, fromUrl); } catch (e) {}
      return fromUrl;
    }
    var stored = '';
    try { stored = localStorage.getItem(VIEWER_KEY) || ''; } catch (e) { stored = ''; }
    return /^[a-f0-9]{16,64}$/i.test(stored) ? stored : '';
  }
  var me = viewer();
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function showError(text) { errorBox.textContent = text || ''; errorBox.hidden = !text; }
  function when(s) {
    if (!s) return '';
    var d = new Date(s * 1000);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  var STATUS = { pending: '审核中', publishing: '发布中', published: '已发布', rejected: '未通过', recalled: '已撤下', failed: '发布失败' };
  function render(items) {
    if (!items.length) { content.innerHTML = '<p class="empty">这个浏览器还没有投稿记录。<br><a href="/submit">去投稿 →</a></p>'; return; }
    var html = '';
    items.forEach(function (item) {
      var unread = (item.unreadComments || 0) + (item.unreadThread || 0);
      html += '<section class="item"><h3>#' + item.id + ' ' + esc(item.title) + (unread ? ' <span class="badge">' + unread + ' 条新消息</span>' : '') + '</h3>';
      html += '<div class="meta"><span class="status ' + esc(item.status) + '">' + (STATUS[item.status] || item.status) + '</span><span>' + when(item.createdAt) + '</span>' + (item.mediaCount ? '<span>' + item.mediaCount + ' 个附件</span>' : '') + '</div>';
      if (item.comments.length) {
        item.comments.forEach(function (c) {
          html += '<div class="comment' + (c.isMine ? ' mine' : '') + '"><div class="who">' + esc(c.name) + (c.parentAuthor ? ' ↩️ 回复 ' + esc(c.parentAuthor) : '') + '<span class="when">' + when(c.createdAt) + '</span></div><div>' + esc(c.text) + '</div>';
          if (!c.isMine) html += '<button class="link" data-reply="' + item.id + ':' + c.messageId + '">↩️ 回复这条评论</button>';
          html += '</div>';
        });
      } else {
        html += '<p class="hint">还没有评论。</p>';
      }
      html += '<div class="thread">';
      if (item.thread.length) {
        item.thread.forEach(function (m) {
          html += '<div class="msg' + (m.direction === 'to_admin' ? ' to_admin' : '') + '">' + (m.direction === 'to_admin' ? '我：' : '管理员：') + esc(m.text) + '<span class="when">' + when(m.createdAt) + '</span></div>';
        });
      } else {
        html += '<p class="hint">想跟管理员说点什么？（只有管理员能看到，不会公开）</p>';
      }
      html += '<div class="row"><textarea data-message="' + item.id + '" placeholder="给管理员留言…" maxlength="800"></textarea><button class="ghost" data-send="' + item.id + '">发送</button></div></div></section>';
    });
    content.innerHTML = html;
  }
  function load() {
    if (!me) { render([]); return; }
    fetch(cfg.inboxUrl + '?t=' + encodeURIComponent(me), { credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (data) { if (!data.ok) throw new Error(data.error || '打不开收件箱'); render(data.items || []); })
      .catch(function (e) { showError(String(e.message || e)); });
  }
  function post(url, payload) {
    showError('');
    fetch(url, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ viewer: me }, payload)) })
      .then(function (r) { return r.json(); })
      .then(function (data) { if (!data.ok) throw new Error(data.error || '操作失败'); load(); })
      .catch(function (e) { showError(String(e.message || e)); });
  }
  document.addEventListener('click', function (event) {
    var target = event.target || {};
    var reply = target.getAttribute && target.getAttribute('data-reply');
    if (reply) {
      var parts = reply.split(':');
      var text = window.prompt('回复这条评论（会以「作者回复」公开出现在评论区）：');
      if (text && text.trim()) post(cfg.replyUrl, { submissionId: Number(parts[0]), commentMessageId: Number(parts[1]), text: text.trim() });
      return;
    }
    var send = target.getAttribute && target.getAttribute('data-send');
    if (send) {
      var box = document.querySelector('[data-message="' + send + '"]');
      if (box && box.value.trim()) post(cfg.messageUrl, { submissionId: Number(send), text: box.value.trim() });
    }
  });
  load();
})();
</script>
</body>
</html>`;
}
