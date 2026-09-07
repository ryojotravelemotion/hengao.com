/* =====================================================================
   変顔ドットコム  —  画面の全部
   Supabase に直接つなぐだけの、ビルド不要な素の JavaScript。
   ===================================================================== */

/* ------------------------------ 設定 ------------------------------ */

const CONFIG = window.HENGAO_CONFIG || {};
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.115.0/+esm';
const BUCKET = 'faces';
const PAGE_SIZE = 24;
const MAX_EDGE = 1400;        // 長辺をこの px まで縮める
const JPEG_QUALITY = 0.86;

const KINDS = [
  { key: 'warota', emoji: '😂', label: 'わろた' },
  { key: 'sugoi',  emoji: '🤩', label: 'すごい' },
  { key: 'kowai',  emoji: '😱', label: 'こわい' },
  { key: 'suki',   emoji: '😍', label: 'すき'   },
];

const POST_COLUMNS =
  'id,created_at,nickname,caption,image_path,width,height,reaction_count,reactions,comment_count';

let supabase = null;

/* ------------------------------ 小道具 ------------------------------ */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** DOM を組み立てる。文字列は必ず textContent 経由なので HTML が混ざらない。 */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 2600);
}

function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const table = [
    [60, 'たった今', 1],
    [3600, '分前', 60],
    [86400, '時間前', 3600],
    [604800, '日前', 86400],
  ];
  for (const [limit, unit, div] of table) {
    if (seconds < limit) return unit === 'たった今' ? unit : `${Math.floor(seconds / div)}${unit}`;
  }
  return new Date(iso).toLocaleDateString('ja-JP');
}

function imageUrl(path) {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return URL.createObjectURL(new Blob()).split('/').pop();
}

/* ---------------------- このブラウザの覚えごと ---------------------- */

const store = {
  read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 無視 */ }
  },
};

/** 誰か分からないまま「同じ人」と見なすための、ただの乱数。個人情報ではない。 */
function visitorId() {
  let id = store.read('hengao.visitor', null);
  if (typeof id !== 'string' || id.length < 8) {
    id = `v-${randomId()}`;
    store.write('hengao.visitor', id);
  }
  return id;
}

const myKeys = {
  all: () => store.read('hengao.keys', {}),
  get(kind, id) { return this.all()[`${kind}:${id}`] || null; },
  set(kind, id, key) {
    const all = this.all();
    all[`${kind}:${id}`] = key;
    store.write('hengao.keys', all);
  },
  forget(kind, id) {
    const all = this.all();
    delete all[`${kind}:${id}`];
    store.write('hengao.keys', all);
  },
};

function generateDeleteKey() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(8))]
    .map((n) => alphabet[n % alphabet.length]).join('');
}

/* ------------------------------ 画像処理 ------------------------------ */

/** 選ばれた写真を読み込む。位置情報などの Exif は、この後の描き直しで消える。 */
async function decodeImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('画像ファイルを選んでください');
  if (file.size > 25 * 1024 * 1024) throw new Error('写真が大きすぎます（25MBまで）');
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(file);   // 古いブラウザ向け
  }
}

/**
 * いま切り抜かれている範囲を、元の写真の座標で返す。
 * 比率が未指定なら写真そのまま。指定があれば、その形で最大まで取った枠を
 * 拡大率で縮め、中心をはみ出さない位置に収める。
 */
function cropRect() {
  const image = composer.bitmap;
  if (!image) return null;
  if (!composer.ratio) {
    return { sx: 0, sy: 0, sw: image.width, sh: image.height };
  }

  const baseWidth = Math.min(image.width, image.height * composer.ratio);
  const baseHeight = baseWidth / composer.ratio;
  const width = baseWidth / composer.zoom;
  const height = baseHeight / composer.zoom;

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const centerX = clamp(composer.center.x * image.width, width / 2, image.width - width / 2);
  const centerY = clamp(composer.center.y * image.height, height / 2, image.height - height / 2);

  return { sx: centerX - width / 2, sy: centerY - height / 2, sw: width, sh: height };
}

/** 切り抜き後の画面表示を描き直す */
function renderPreview() {
  const canvas = $('#preview');
  const rect = cropRect();
  if (!rect) return;

  const maxWidth = 520;
  const maxHeight = Math.round(window.innerHeight * 0.4);
  const scale = Math.min(1, maxWidth / rect.sw, maxHeight / rect.sh);
  canvas.width = Math.max(1, Math.round(rect.sw * scale));
  canvas.height = Math.max(1, Math.round(rect.sh * scale));

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(composer.bitmap, rect.sx, rect.sy, rect.sw, rect.sh,
                0, 0, canvas.width, canvas.height);

  const output = outputSize(rect);
  $('#image-note').textContent =
    `投稿される大きさ ${output.width}×${output.height}（位置情報などは削除されます）`;
}

/** 実際に投稿する大きさ。長辺を MAX_EDGE までに収める。 */
function outputSize(rect) {
  const scale = Math.min(1, MAX_EDGE / Math.max(rect.sw, rect.sh));
  return {
    width: Math.max(1, Math.round(rect.sw * scale)),
    height: Math.max(1, Math.round(rect.sh * scale)),
  };
}

/** いまの切り抜きで、送信用の JPEG を書き出す */
async function exportImage() {
  const rect = cropRect();
  if (!rect) throw new Error('写真を選んでください');

  const { width, height } = outputSize(rect);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(composer.bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, width, height);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('画像を変換できませんでした'))),
      'image/jpeg', JPEG_QUALITY);
  });
  return { blob, width, height };
}

/* ------------------------------ 通信 ------------------------------ */

async function fetchPosts(sort, offset) {
  let query = supabase.from('posts').select(POST_COLUMNS);

  if (sort === 'hot') {
    const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    query = query.gte('created_at', since)
                 .order('reaction_count', { ascending: false })
                 .order('created_at', { ascending: false });
  } else if (sort === 'best') {
    query = query.order('reaction_count', { ascending: false })
                 .order('created_at', { ascending: false });
  } else {
    query = query.order('created_at', { ascending: false });
  }

  const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
  if (error) throw error;
  return data ?? [];
}

/** 表示中の投稿のうち、自分がリアクション済みのものを調べる。 */
async function fetchMyReactions(postIds) {
  if (postIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from('reactions').select('post_id,kind')
    .eq('visitor', visitorId()).in('post_id', postIds);
  if (error) return new Set();
  return new Set((data ?? []).map((r) => `${r.post_id}:${r.kind}`));
}

/* ------------------------------ 一覧画面 ------------------------------ */

const timeline = { sort: 'new', offset: 0, done: false, loading: false };

function postCard(post) {
  const img = h('img', {
    src: imageUrl(post.image_path),
    alt: post.caption || `${post.nickname}さんの変顔`,
    loading: 'lazy', decoding: 'async',
    width: post.width || undefined, height: post.height || undefined,
  });

  return h('article', { class: 'card' },
    h('a', { class: 'card-media', href: `#/p/${post.id}` }, img),
    h('div', { class: 'card-body' },
      post.caption && h('p', { class: 'card-caption' }, post.caption),
      h('div', { class: 'card-meta' },
        h('span', { class: 'name' }, post.nickname),
        h('span', {}, timeAgo(post.created_at)),
      ),
      h('div', { class: 'card-stats' },
        h('span', {}, `😂 ${post.reaction_count}`),
        h('span', {}, `💬 ${post.comment_count}`),
      ),
    ),
  );
}

function showSkeletons(count = 6) {
  const grid = $('#grid');
  for (let i = 0; i < count; i += 1) {
    grid.append(h('div', {
      class: 'skeleton',
      style: `height:${180 + ((i * 53) % 140)}px`,
    }));
  }
}

async function loadTimeline(reset = false) {
  if (timeline.loading) return;
  if (reset) {
    timeline.offset = 0;
    timeline.done = false;
    $('#grid').replaceChildren();
  }
  if (timeline.done) return;

  timeline.loading = true;
  $('#load-more').disabled = true;
  const firstPage = timeline.offset === 0;
  if (firstPage) showSkeletons();

  try {
    const posts = await fetchPosts(timeline.sort, timeline.offset);
    if (firstPage) $$('#grid .skeleton').forEach((n) => n.remove());

    $('#grid').append(...posts.map(postCard));
    timeline.offset += posts.length;
    timeline.done = posts.length < PAGE_SIZE;

    $('#timeline-empty').hidden = !(timeline.offset === 0 && timeline.done);
    $('#load-more').hidden = timeline.done;
  } catch (error) {
    if (firstPage) $$('#grid .skeleton').forEach((n) => n.remove());
    toast(`読み込めませんでした: ${error.message}`, true);
  } finally {
    timeline.loading = false;
    $('#load-more').disabled = false;
  }
}

/* ------------------------------ 詳細画面 ------------------------------ */

function reactionBar(post, mine) {
  const bar = h('div', { class: 'reactions' });

  for (const kind of KINDS) {
    const count = Number(post.reactions?.[kind.key] ?? 0);
    const button = h('button', {
      class: 'reaction', type: 'button',
      'aria-pressed': mine.has(`${post.id}:${kind.key}`) ? 'true' : 'false',
      'aria-label': `${kind.label} (${count})`,
      dataset: { kind: kind.key },
    },
      h('span', { 'aria-hidden': 'true' }, kind.emoji),
      h('span', {}, kind.label),
      h('span', { class: 'count' }, String(count)),
    );

    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const { data, error } = await supabase.rpc('toggle_reaction', {
          p_post_id: post.id, p_kind: kind.key, p_visitor: visitorId(),
        });
        if (error) throw error;
        post.reactions = data.reactions;
        post.reaction_count = data.reaction_count;
        button.setAttribute('aria-pressed', data.reacted ? 'true' : 'false');
        const next = Number(data.reactions?.[kind.key] ?? 0);
        $('.count', button).textContent = String(next);
        button.setAttribute('aria-label', `${kind.label} (${next})`);
      } catch (error) {
        toast(error.message, true);
      } finally {
        button.disabled = false;
      }
    });

    bar.append(button);
  }
  return bar;
}

function commentNode(comment, postId, onRemoved) {
  const ownKey = myKeys.get('comment', comment.id) || myKeys.get('post', postId);
  const actions = h('div', { class: 'comment-actions' },
    h('button', {
      class: 'link-btn', type: 'button',
      onclick: () => reportContent('comment', comment.id),
    }, '通報'),
  );

  if (ownKey) {
    actions.prepend(h('button', {
      class: 'link-btn', type: 'button',
      onclick: async () => {
        if (!confirm('このコメントを削除しますか？')) return;
        const { error } = await supabase.rpc('delete_comment', {
          p_comment_id: comment.id, p_delete_key: ownKey,
        });
        if (error) { toast(error.message, true); return; }
        myKeys.forget('comment', comment.id);
        toast('削除しました');
        onRemoved();
      },
    }, '削除'));
  }

  return h('article', { class: 'comment' },
    h('div', { class: 'comment-head' },
      h('span', { class: 'name' }, comment.nickname),
      h('time', { datetime: comment.created_at }, timeAgo(comment.created_at)),
    ),
    h('p', { class: 'comment-body' }, comment.body),
    actions,
  );
}

function commentForm(postId, onPosted) {
  const body = h('textarea', { rows: '2', maxlength: '300', required: true,
                               placeholder: '思ったことをどうぞ（300字まで）' });
  const nickname = h('input', { type: 'text', maxlength: '20', placeholder: '名無しさん' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'コメントする');

  const form = h('form', { class: 'comment-form' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'コメント'), body),
    h('label', { class: 'field' },
      h('span', { class: 'field-label' }, '名前 ', h('span', { class: 'muted small' }, '(任意)')),
      nickname),
    h('div', { class: 'center' }, submit),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!body.value.trim()) return;

    submit.disabled = true;
    const deleteKey = generateDeleteKey();
    try {
      const { data, error } = await supabase.rpc('add_comment', {
        p_post_id: postId,
        p_body: body.value,
        p_delete_key: deleteKey,
        p_visitor: visitorId(),
        p_nickname: nickname.value || null,
      });
      if (error) throw error;
      myKeys.set('comment', data.id, deleteKey);
      body.value = '';
      toast('コメントしました');
      onPosted();
    } catch (error) {
      toast(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  return form;
}

async function reportContent(refType, refId) {
  const label = refType === 'post' ? 'この投稿' : 'このコメント';
  if (!confirm(`${label}を通報しますか？\n3人から通報が集まると自動的に非表示になります。`)) return;
  const reason = prompt('よければ理由を教えてください（任意）', '') ?? '';
  const { error } = await supabase.rpc('report_content', {
    p_ref_type: refType, p_ref_id: refId, p_visitor: visitorId(), p_reason: reason,
  });
  if (error) { toast(error.message, true); return; }
  toast('通報を受け付けました');
}

async function renderPostView(postId) {
  const container = $('#post-detail');
  container.replaceChildren(h('p', { class: 'empty' }, '読み込んでいます…'));

  const [postResult, commentsResult] = await Promise.all([
    supabase.from('posts').select(POST_COLUMNS).eq('id', postId).maybeSingle(),
    supabase.from('comments').select('id,post_id,created_at,nickname,body')
            .eq('post_id', postId).order('created_at', { ascending: true }),
  ]);

  if (postResult.error || !postResult.data) {
    container.replaceChildren(h('p', { class: 'empty' },
      'この投稿は見つかりませんでした。削除されたか、非表示になっています。'));
    return;
  }

  const post = postResult.data;
  const comments = commentsResult.data ?? [];
  const mine = await fetchMyReactions([post.id]);
  const ownKey = myKeys.get('post', post.id);

  const actions = h('div', { class: 'detail-actions' },
    h('button', { class: 'link-btn', type: 'button',
                  onclick: () => reportContent('post', post.id) }, 'この投稿を通報'),
  );

  if (ownKey) {
    actions.prepend(h('button', {
      class: 'link-btn', type: 'button',
      onclick: async () => {
        if (!confirm('この投稿を削除しますか？元に戻せません。')) return;
        const { error } = await supabase.rpc('delete_post', {
          p_post_id: post.id, p_delete_key: ownKey,
        });
        if (error) { toast(error.message, true); return; }
        myKeys.forget('post', post.id);
        toast('削除しました');
        location.hash = '#/';
      },
    }, '自分の投稿を削除'));
  }

  const reload = () => renderPostView(postId);

  container.replaceChildren(
    h('article', { class: 'detail' },
      h('div', { class: 'detail-media' },
        h('img', {
          src: imageUrl(post.image_path),
          alt: post.caption || `${post.nickname}さんの変顔`,
          width: post.width || undefined, height: post.height || undefined,
        })),
      h('div', { class: 'detail-body' },
        post.caption && h('h2', { class: 'detail-caption' }, post.caption),
        h('div', { class: 'detail-meta' },
          h('strong', {}, post.nickname),
          h('time', { datetime: post.created_at }, timeAgo(post.created_at)),
        ),
        reactionBar(post, mine),
        actions,
      ),
    ),
    h('section', { class: 'comments' },
      h('h2', {}, `コメント ${comments.length}件`),
      ...comments.map((c) => commentNode(c, post.id, reload)),
      commentForm(post.id, reload),
    ),
  );
}

/* ------------------------------ 投稿フォーム ------------------------------ */

const composer = {
  bitmap: null,                 // 元の写真
  ratio: null,                  // 切り抜く形（幅÷高さ）。null なら元のまま
  zoom: 1,                      // 拡大率
  center: { x: 0.5, y: 0.5 },   // 切り抜く位置（写真全体に対する割合）
};

function resetComposer() {
  composer.bitmap?.close?.();
  composer.bitmap = null;
  composer.ratio = null;
  composer.zoom = 1;
  composer.center = { x: 0.5, y: 0.5 };

  $('#composer-form').reset();
  $('#stage').hidden = true;
  $('#crop-tools').hidden = true;
  $('#zoom-row').hidden = true;
  $('#dropzone').hidden = false;
  $('#composer-error').hidden = true;
  $('#zoom').value = '100';
  $$('.ratio').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.ratio === '')));
  $('#submit-post').disabled = false;
  $('#submit-post').textContent = '投稿する';
}

async function acceptFile(file) {
  if (!file) return;
  const error = $('#composer-error');
  error.hidden = true;
  try {
    const bitmap = await decodeImage(file);
    composer.bitmap?.close?.();
    composer.bitmap = bitmap;
    composer.zoom = 1;
    composer.center = { x: 0.5, y: 0.5 };
    $('#zoom').value = '100';

    $('#dropzone').hidden = true;
    $('#stage').hidden = false;
    $('#crop-tools').hidden = false;
    updateCropControls();
    renderPreview();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
}

/** 切り抜きの操作欄の出し入れ。「そのまま」のときは動かす余地がない。 */
function updateCropControls() {
  const cropping = Boolean(composer.ratio);
  $('#zoom-row').hidden = !cropping;
  $('#preview').classList.toggle('draggable', cropping);
}

/** 写真をドラッグして切り抜く位置を動かす */
function setUpCropDragging() {
  const canvas = $('#preview');
  let dragging = null;

  canvas.addEventListener('pointerdown', (event) => {
    if (!composer.ratio) return;
    dragging = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('grabbing');
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!dragging || !composer.bitmap) return;
    const rect = cropRect();
    const box = canvas.getBoundingClientRect();

    // 画面上で動かした分を、元の写真の座標に読み替える
    composer.center.x -= ((event.clientX - dragging.x) / box.width) * (rect.sw / composer.bitmap.width);
    composer.center.y -= ((event.clientY - dragging.y) / box.height) * (rect.sh / composer.bitmap.height);
    dragging = { x: event.clientX, y: event.clientY };
    renderPreview();
  });

  const endDrag = () => { dragging = null; canvas.classList.remove('grabbing'); };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  $('#zoom').addEventListener('input', (event) => {
    composer.zoom = Number(event.target.value) / 100;
    renderPreview();
  });

  $$('.ratio').forEach((button) => button.addEventListener('click', () => {
    composer.ratio = button.dataset.ratio ? Number(button.dataset.ratio) : null;
    composer.zoom = 1;
    composer.center = { x: 0.5, y: 0.5 };
    $('#zoom').value = '100';
    $$('.ratio').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
    updateCropControls();
    renderPreview();
  }));
}

async function submitPost(event) {
  event.preventDefault();
  const error = $('#composer-error');
  const submit = $('#submit-post');
  error.hidden = true;

  if (!composer.bitmap) {
    error.textContent = '写真を選んでください';
    error.hidden = false;
    return;
  }
  if (!$('#consent').checked) {
    error.textContent = '確認のチェックをお願いします';
    error.hidden = false;
    return;
  }

  const typedKey = $('#delete-key').value.trim();
  if (typedKey && typedKey.length < 4) {
    error.textContent = '削除キーは4文字以上にしてください';
    error.hidden = false;
    return;
  }
  const deleteKey = typedKey || generateDeleteKey();

  submit.disabled = true;
  submit.textContent = '準備中…';

  try {
    const prepared = await exportImage();
    submit.textContent = 'アップロード中…';
    const now = new Date();
    const path = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${randomId()}.jpg`;

    const upload = await supabase.storage.from(BUCKET)
      .upload(path, prepared.blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
    if (upload.error) throw upload.error;

    submit.textContent = '投稿中…';
    const { data, error: rpcError } = await supabase.rpc('create_post', {
      p_image_path: path,
      p_delete_key: deleteKey,
      p_visitor: visitorId(),
      p_nickname: $('#nickname').value || null,
      p_caption: $('#caption').value || null,
      p_width: prepared.width,
      p_height: prepared.height,
    });
    if (rpcError) throw rpcError;

    myKeys.set('post', data.id, deleteKey);
    $('#composer').close();
    resetComposer();

    $('#done-key').textContent = deleteKey;
    $('#done-dialog').showModal();

    timeline.sort = 'new';
    $$('.tab').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.sort === 'new')));
    if (location.hash && location.hash !== '#/') location.hash = '#/';
    else await loadTimeline(true);
  } catch (err) {
    error.textContent = err.message || '投稿できませんでした';
    error.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = '投稿する';
  }
}

/* ------------------------------ ルーティング ------------------------------ */

function showView(name) {
  for (const id of ['view-setup', 'view-timeline', 'view-post']) {
    $(`#${id}`).hidden = (id !== `view-${name}`);
  }
}

async function route() {
  const match = location.hash.match(/^#\/p\/([0-9a-f-]{36})$/i);
  if (match) {
    showView('post');
    window.scrollTo(0, 0);
    await renderPostView(match[1]);
  } else {
    showView('timeline');
    if (timeline.offset === 0) await loadTimeline(true);
  }
}

/* ------------------------------ 起動 ------------------------------ */

function wireUp() {
  // 投稿ダイアログ
  const dialog = $('#composer');
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'open-composer') { resetComposer(); dialog.showModal(); }
    if (action === 'close-composer') { dialog.close(); resetComposer(); }
    if (action === 'close-done') $('#done-dialog').close();
    if (action === 'pick-again') $('#file-input').click();
    // 直接この URL を開いた人が、外に出てしまわないように
    if (action === 'back') {
      if (history.length > 1) history.back();
      else location.hash = '#/';
    }
  });

  $('#composer-form').addEventListener('submit', submitPost);
  $('#file-input').addEventListener('change', (e) => acceptFile(e.target.files[0]));
  setUpCropDragging();

  const dropzone = $('#dropzone');
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#file-input').click(); }
  });

  const body = $('.composer-body');
  ['dragenter', 'dragover'].forEach((type) => body.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((type) => body.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
  }));
  body.addEventListener('drop', (event) => acceptFile(event.dataTransfer?.files?.[0]));

  document.addEventListener('paste', (event) => {
    if (!dialog.open) return;
    const file = [...(event.clipboardData?.files ?? [])][0];
    if (file) acceptFile(file);
  });

  // 並び替えタブ
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    if (timeline.sort === tab.dataset.sort) return;
    timeline.sort = tab.dataset.sort;
    $$('.tab').forEach((other) => other.setAttribute('aria-selected', String(other === tab)));
    loadTimeline(true);
  }));

  $('#load-more').addEventListener('click', () => loadTimeline());
  window.addEventListener('hashchange', route);
}

/**
 * Supabase の接続先を整える。
 * 管理画面には似た URL が並んでいて、Project URL の代わりに
 * API のエンドポイント（.../rest/v1 など）を貼ってしまいやすいので、
 * その分を取り除いてから使う。
 */
function normalizeSupabaseUrl(url) {
  const cleaned = String(url).trim()
    .replace(/\/+$/, '')
    .replace(/\/(rest|storage|auth|realtime|functions)\/v1$/, '');
  if (cleaned !== String(url).trim()) {
    console.warn(`接続先を ${cleaned} として扱います（Project URL 以外が指定されていました）`);
  }
  return cleaned;
}

/** VS Code の Live Server などで手元から開いているか */
function isLocalPreview() {
  const host = location.hostname.replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1', ''].includes(host);
}

/** お試しモードで開いていることを、画面の上に出しておく */
function showDemoBanner() {
  const note = h('p', { class: 'demo-note' },
    'お試しモードです。投稿はこのブラウザの中だけに保存され、他の人には見えません。',
    h('br'),
    'みんなで使うには config.js に Supabase の接続先を書いてください。');
  document.querySelector('.site-header').after(note);
}

async function start() {
  const { supabaseUrl, supabaseAnonKey } = CONFIG;

  if (supabaseUrl && supabaseAnonKey) {
    // 接続先が設定されているときだけ、Supabase の部品を読み込む
    const { createClient } = await import(SUPABASE_JS);
    supabase = createClient(normalizeSupabaseUrl(supabaseUrl), supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } else if (isLocalPreview()) {
    // 接続先が未設定でも、手元でなら中身を触って確かめられるようにする
    const { createDemoClient } = await import('./demo-backend.js');
    supabase = createDemoClient();
    showDemoBanner();
  } else {
    showView('setup');
    return;
  }

  wireUp();
  route();
}

start();
