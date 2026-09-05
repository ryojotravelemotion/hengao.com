/* =====================================================================
   お試しモード
   Supabase の設定がまだのとき、手元（localhost）で開いた場合だけ使われます。
   投稿はこのブラウザの中だけに保存され、他の人には見えません。
   Supabase の接続先を config.js に書けば、自動的に本番の動きに戻ります。
   ===================================================================== */

const STORE_KEY = 'hengao.demo.store';
const REACTION_KEY = 'hengao.demo.reactions';
const MAX_IMAGE_BYTES = 140 * 1024;   // ブラウザの保存容量に収めるため
const uploads = new Map();            // アップロード直後の画像（パス → data URL）

/* ------------------------- 保存先 ------------------------- */

const readAll = () => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch { return {}; }
};

const writeAll = (all) => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); }
  catch { throw new Error('このブラウザの保存容量がいっぱいです。古い投稿を削除してください'); }
};

const store = {
  get(path) { return readAll()[path] ?? null; },
  set(path, data) { const all = readAll(); all[path] = data; writeAll(all); },
  update(path, patch) {
    const all = readAll();
    all[path] = { ...(all[path] || {}), ...patch };
    writeAll(all);
  },
  remove(path) {
    const all = readAll();
    for (const key of Object.keys(all)) {
      if (key === path || key.startsWith(`${path}/`)) delete all[key];
    }
    writeAll(all);
  },
  /** そのコレクションの直下にある文書だけを、新しい順で返す */
  list(path) {
    const all = readAll();
    return Object.entries(all)
      .filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
      .map(([, value]) => value)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  },
};

/* ------------------------- 小道具 ------------------------- */

const newId = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** 削除キーはそのままでは持たず、本番と同じくハッシュにして保存する */
async function hashKey(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`hengao:${key}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const myReactions = {
  all() { try { return JSON.parse(localStorage.getItem(REACTION_KEY)) || {}; } catch { return {}; } },
  has(postId, kind) { return Boolean(this.all()[`${postId}:${kind}`]); },
  toggle(postId, kind, on) {
    const all = this.all();
    if (on) all[`${postId}:${kind}`] = true;
    else delete all[`${postId}:${kind}`];
    try { localStorage.setItem(REACTION_KEY, JSON.stringify(all)); } catch { /* 無視 */ }
  },
};

/** 保存容量に収まるまで、画質と大きさを落とす */
async function shrinkToFit(blob) {
  if (blob.size <= MAX_IMAGE_BYTES) return blob;
  const bitmap = await createImageBitmap(blob);
  let quality = 0.78;
  let scale = 1;
  let out = blob;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (out.size <= MAX_IMAGE_BYTES) break;
    if (quality > 0.45) quality -= 0.12;
    else scale *= 0.8;
  }
  bitmap.close?.();
  return out;
}

const toDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('画像を読み込めませんでした'));
  reader.readAsDataURL(blob);
});

const fail = (message) => ({ data: null, error: { message } });

/* ------------------------- 読み取り ------------------------- */

function runQuery(state) {
  if (state.table === 'posts') {
    if (state.eq.id) {
      const post = store.get(`posts/${state.eq.id}`);
      return { data: post && !post.is_hidden ? post : null, error: null };
    }
    let rows = store.list('posts').filter((post) => post && !post.is_hidden);
    if (state.gte) rows = rows.filter((post) => post[state.gte[0]] >= state.gte[1]);
    for (const [column, ascending] of [...state.orders].reverse()) {
      rows.sort((a, b) => {
        const [x, y] = [a[column] ?? 0, b[column] ?? 0];
        return (x > y ? 1 : x < y ? -1 : 0) * (ascending ? 1 : -1);
      });
    }
    if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
    return { data: rows, error: null };
  }

  if (state.table === 'comments') {
    const rows = store.list(`posts/${state.eq.post_id}/comments`)
      .filter((comment) => comment && !comment.is_hidden)
      .sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
    return { data: rows, error: null };
  }

  if (state.table === 'reactions') {
    const ids = state.inFilter ? state.inFilter[1] : [];
    const rows = Object.keys(myReactions.all())
      .map((key) => {
        const separator = key.lastIndexOf(':');
        return { post_id: key.slice(0, separator), kind: key.slice(separator + 1) };
      })
      .filter((reaction) => ids.includes(reaction.post_id));
    return { data: rows, error: null };
  }

  return { data: [], error: null };
}

function from(table) {
  const state = { table, eq: {}, gte: null, inFilter: null, orders: [], range: null };
  const chain = {
    select: () => chain,
    eq(column, value) { state.eq[column] = value; return chain; },
    gte(column, value) { state.gte = [column, value]; return chain; },
    in(column, values) { state.inFilter = [column, values]; return chain; },
    order(column, options = {}) { state.orders.push([column, options.ascending !== false]); return chain; },
    range(start, end) { state.range = [start, end]; return chain; },
    maybeSingle() { return chain; },
    then(resolve, reject) {
      try { resolve(runQuery(state)); } catch (error) { reject(error); }
    },
  };
  return chain;
}

/* ------------------------- 書き込み ------------------------- */

const rpcs = {
  async create_post(params) {
    const image = uploads.get(params.p_image_path);
    if (!image) return fail('画像が見つかりません');

    const post = {
      id: newId(),
      created_at: new Date().toISOString(),
      nickname: (params.p_nickname || '').trim().slice(0, 20) || '名無しの変顔',
      caption: (params.p_caption || '').trim().slice(0, 140),
      image_path: image,
      width: params.p_width,
      height: params.p_height,
      key_hash: await hashKey(params.p_delete_key),
      reaction_count: 0,
      reactions: {},
      comment_count: 0,
      report_count: 0,
      is_hidden: false,
    };
    store.set(`posts/${post.id}`, post);
    uploads.delete(params.p_image_path);
    return { data: post, error: null };
  },

  async add_comment(params) {
    const post = store.get(`posts/${params.p_post_id}`);
    if (!post) return fail('この投稿は見つかりません');
    if (!params.p_body.trim()) return fail('コメントが空です');

    const comment = {
      id: newId(),
      post_id: post.id,
      created_at: new Date().toISOString(),
      nickname: (params.p_nickname || '').trim().slice(0, 20) || '名無しさん',
      body: params.p_body.trim().slice(0, 300),
      key_hash: await hashKey(params.p_delete_key),
      is_hidden: false,
    };
    store.set(`posts/${post.id}/comments/${comment.id}`, comment);
    store.update(`posts/${post.id}`, { comment_count: (post.comment_count || 0) + 1 });
    return { data: comment, error: null };
  },

  async toggle_reaction(params) {
    const post = store.get(`posts/${params.p_post_id}`);
    if (!post) return fail('この投稿は見つかりません');

    const reacted = !myReactions.has(post.id, params.p_kind);
    const reactions = { ...(post.reactions || {}) };
    reactions[params.p_kind] = Math.max(0, (reactions[params.p_kind] || 0) + (reacted ? 1 : -1));
    if (reactions[params.p_kind] === 0) delete reactions[params.p_kind];
    const reaction_count = Object.values(reactions).reduce((sum, n) => sum + n, 0);

    store.update(`posts/${post.id}`, { reactions, reaction_count });
    myReactions.toggle(post.id, params.p_kind, reacted);
    return { data: { reacted, reactions, reaction_count }, error: null };
  },

  async delete_post(params) {
    const post = store.get(`posts/${params.p_post_id}`);
    if (!post) return fail('この投稿は見つかりません');
    if (post.key_hash !== await hashKey(params.p_delete_key)) return fail('削除キーが違います');
    store.remove(`posts/${post.id}`);
    return { data: true, error: null };
  },

  async delete_comment(params) {
    for (const post of store.list('posts')) {
      const comment = store.get(`posts/${post.id}/comments/${params.p_comment_id}`);
      if (!comment) continue;
      const hash = await hashKey(params.p_delete_key);
      if (comment.key_hash !== hash && post.key_hash !== hash) return fail('削除キーが違います');
      store.remove(`posts/${post.id}/comments/${comment.id}`);
      store.update(`posts/${post.id}`, { comment_count: Math.max(0, (post.comment_count || 1) - 1) });
      return { data: true, error: null };
    }
    return fail('このコメントは見つかりません');
  },

  async report_content(params) {
    if (params.p_ref_type !== 'post') return { data: true, error: null };
    const post = store.get(`posts/${params.p_ref_id}`);
    if (!post) return fail('この投稿は見つかりません');
    const report_count = (post.report_count || 0) + 1;
    store.update(`posts/${post.id}`, { report_count, is_hidden: report_count >= 3 });
    return { data: true, error: null };
  },
};

/* ------------------------- Supabase の代役 ------------------------- */

export function createDemoClient() {
  return {
    from,
    async rpc(name, params) {
      try {
        return await rpcs[name](params);
      } catch (error) {
        return fail(error?.message || '保存できませんでした');
      }
    },
    storage: {
      from: () => ({
        // お試しモードでは画像そのものを持っているので、そのまま返す
        getPublicUrl: (path) => ({ data: { publicUrl: path } }),
        async upload(path, blob) {
          try {
            uploads.set(path, await toDataUrl(await shrinkToFit(blob)));
            return { data: { path }, error: null };
          } catch (error) {
            return { data: null, error: { message: error.message } };
          }
        },
      }),
    },
  };
}
