/* テスト用の偽 Supabase。app.js が使う分だけをメモリ上で再現する。 */
const db = {
  posts: [],
  comments: [],
  reactions: [],
  secrets: {},
};
let seq = 0;
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

// 初期データ
for (let i = 1; i <= 3; i += 1) {
  db.posts.push({
    id: uuid(++seq),
    created_at: new Date(Date.now() - i * 3600 * 1000).toISOString(),
    nickname: `変顔${i}号`,
    caption: i === 2 ? '' : `渾身の${i}枚目`,
    image_path: `2026/09/${uuid(i)}.jpg`,
    width: 400, height: 300,
    reaction_count: 4 - i,
    reactions: i === 1 ? { warota: 3 } : { sugoi: 4 - i },
    comment_count: i === 1 ? 1 : 0,
  });
}
db.comments.push({
  id: uuid(++seq), post_id: db.posts[0].id,
  created_at: new Date().toISOString(), nickname: '通りすがり', body: 'くっそわろた',
});

function builder(table) {
  const state = { table, filters: [], orders: [], range: null, single: false };
  const chain = {
    select() { return chain; },
    eq(col, val) { state.filters.push((r) => r[col] === val); return chain; },
    gte(col, val) { state.filters.push((r) => r[col] >= val); return chain; },
    in(col, vals) { state.filters.push((r) => vals.includes(r[col])); return chain; },
    order(col, opts = {}) { state.orders.push([col, opts.ascending !== false]); return chain; },
    range(from, to) { state.range = [from, to]; return chain; },
    maybeSingle() { state.single = true; return chain; },
    then(resolve) {
      let rows = db[state.table].filter((row) => state.filters.every((f) => f(row)));
      for (const [col, asc] of [...state.orders].reverse()) {
        rows = rows.slice().sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
      resolve(state.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null });
    },
  };
  return chain;
}

const rpcs = {
  create_post(p) {
    if (!db.uploads?.includes(p.p_image_path)) return { data: null, error: { message: '画像が見つかりません' } };
    const post = {
      id: uuid(++seq), created_at: new Date().toISOString(),
      nickname: (p.p_nickname || '').trim() || '名無しの変顔',
      caption: (p.p_caption || '').trim(),
      image_path: p.p_image_path, width: p.p_width, height: p.p_height,
      reaction_count: 0, reactions: {}, comment_count: 0,
    };
    db.posts.push(post);
    db.secrets[`post:${post.id}`] = p.p_delete_key;
    return { data: post, error: null };
  },
  add_comment(p) {
    if (!p.p_body.trim()) return { data: null, error: { message: 'コメントが空です' } };
    const comment = {
      id: uuid(++seq), post_id: p.p_post_id, created_at: new Date().toISOString(),
      nickname: (p.p_nickname || '').trim() || '名無しさん', body: p.p_body.trim(),
    };
    db.comments.push(comment);
    db.secrets[`comment:${comment.id}`] = p.p_delete_key;
    const post = db.posts.find((x) => x.id === p.p_post_id);
    if (post) post.comment_count += 1;
    return { data: comment, error: null };
  },
  toggle_reaction(p) {
    const key = (r) => r.post_id === p.p_post_id && r.visitor === p.p_visitor && r.kind === p.p_kind;
    const index = db.reactions.findIndex(key);
    let reacted;
    if (index >= 0) { db.reactions.splice(index, 1); reacted = false; }
    else { db.reactions.push({ post_id: p.p_post_id, visitor: p.p_visitor, kind: p.p_kind }); reacted = true; }
    const post = db.posts.find((x) => x.id === p.p_post_id);
    const mineForPost = db.reactions.filter((r) => r.post_id === p.p_post_id);
    const base = { ...post.reactions };
    const delta = reacted ? 1 : -1;
    base[p.p_kind] = Math.max(0, (base[p.p_kind] ?? 0) + delta);
    if (base[p.p_kind] === 0) delete base[p.p_kind];
    post.reactions = base;
    post.reaction_count = Object.values(base).reduce((a, b) => a + b, 0);
    void mineForPost;
    return { data: { reacted, reactions: post.reactions, reaction_count: post.reaction_count }, error: null };
  },
  delete_post(p) {
    if (db.secrets[`post:${p.p_post_id}`] !== p.p_delete_key) {
      return { data: null, error: { message: '削除キーが違います' } };
    }
    db.posts = db.posts.filter((x) => x.id !== p.p_post_id);
    db.comments = db.comments.filter((c) => c.post_id !== p.p_post_id);
    return { data: true, error: null };
  },
  delete_comment(p) {
    const comment = db.comments.find((c) => c.id === p.p_comment_id);
    if (!comment) return { data: null, error: { message: 'このコメントは見つかりません' } };
    const ok = db.secrets[`comment:${p.p_comment_id}`] === p.p_delete_key
            || db.secrets[`post:${comment.post_id}`] === p.p_delete_key;
    if (!ok) return { data: null, error: { message: '削除キーが違います' } };
    db.comments = db.comments.filter((c) => c.id !== p.p_comment_id);
    const post = db.posts.find((x) => x.id === comment.post_id);
    if (post) post.comment_count -= 1;
    return { data: true, error: null };
  },
  report_content() { return { data: true, error: null }; },
};

export function createClient() {
  db.uploads = db.uploads || [];
  window.__mockDb = db;
  return {
    from: (table) => builder(table),
    rpc: async (name, params) => {
      window.__rpcCalls = window.__rpcCalls || [];
      window.__rpcCalls.push([name, params]);
      return rpcs[name] ? rpcs[name](params) : { data: null, error: { message: `unknown rpc ${name}` } };
    },
    storage: {
      from: () => ({
        getPublicUrl: (path) => ({ data: { publicUrl: `/mock-image.png?p=${encodeURIComponent(path)}` } }),
        upload: async (path, blob) => {
          db.uploads.push(path);
          window.__uploads = window.__uploads || [];
          window.__uploads.push({ path, size: blob.size, type: blob.type });
          return { data: { path }, error: null };
        },
      }),
    },
  };
}
