# 変顔.com

自由に変顔を投稿して、みんなでコメントし合うためのサイトです。
ログインは要りません。写真を選んで、ひとこと添えて、投稿するだけ。

- **フロントエンド** — HTML / CSS / JavaScript だけ。ビルド作業なし。GitHub Pages で配信します。
- **バックエンド** — Supabase（PostgreSQL + Storage）。ブラウザから直接つなぎます。
- **サーバの管理は不要** — 自分で用意して動かし続けるサーバはありません。

```
   ブラウザ ──── 画像 ────▶  Supabase Storage (faces バケット)
      │
      └─── 投稿/コメント ──▶  Supabase PostgreSQL
                               （RLS + RPC 関数で保護）
   ページ本体は GitHub Pages から配信
```

## できること

| | |
|---|---|
| 変顔の投稿 | 写真を選ぶ・ドロップ・スマホでその場撮影・貼り付け（Ctrl+V） |
| 自動で軽量化 | 長辺 1400px の JPEG に描き直し。**位置情報などの Exif は消えます** |
| コメント | 投稿ごとに、名前も任意で書き込み |
| リアクション | 😂 わろた / 🤩 すごい / 😱 こわい / 😍 すき |
| 並び替え | 新着・今週の人気・殿堂入り |
| 自分で削除 | 投稿時に発行される削除キーで、あとから消せます |
| 通報 | 3人から通報が集まると自動で非表示になります |

---

## セットアップ

### 1. Supabase を用意する

1. [supabase.com](https://supabase.com/dashboard) でプロジェクトを作ります（無料枠で十分です）。
2. 左メニューの **SQL Editor** を開き、このリポジトリの
   [`supabase/schema.sql`](supabase/schema.sql) の中身を全部貼り付けて **Run**。
   テーブル・権限設定・画像用バケット・処理用の関数が一度に作られます。
   何度実行しても壊れないので、あとで作り直しても大丈夫です。
3. **Project Settings → API** を開き、次の2つを控えます。
   - **Project URL**（例: `https://abcdefgh.supabase.co`）
   - **anon public** キー

> **anon キーは公開して構いません。** ブラウザに配るためのキーで、
> できることは Supabase 側のルール（RLS）で縛ってあります。
> ただし **service_role キーは絶対に貼らないでください。** あれは何でもできてしまいます。

### 2. 接続先を設定する

**方法A：GitHub の Secrets に入れる（おすすめ）**

リポジトリの Settings → Secrets and variables → Actions → *New repository secret* で登録します。

| 名前 | 中身 |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon public キー |

デプロイのたびに `public/config.js` が自動で作られます。

**方法B：ファイルに直接書く**

[`public/config.js`](public/config.js) を編集して、そのままコミットします。

```js
window.HENGAO_CONFIG = {
  supabaseUrl: "https://abcdefgh.supabase.co",
  supabaseAnonKey: "eyJhbG...",
};
```

### 3. GitHub Pages を有効にする

Settings → Pages → **Source** を **GitHub Actions** に変更します。
あとは `main` ブランチに push すれば
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) が公開まで済ませます。

### 4. 独自ドメイン「変顔.com」をつなぐ（任意）

日本語ドメインは内部的には Punycode の **`xn--ursw68l.com`** として扱われます。

1. リポジトリの Settings → Secrets and variables → Actions → **Variables** タブで
   `CUSTOM_DOMAIN` に `xn--ursw68l.com` を登録します（デプロイ時に CNAME ファイルが置かれます）。
2. ドメインの DNS に、GitHub Pages 用のレコードを設定します。

   ```
   A    @   185.199.108.153
   A    @   185.199.109.153
   A    @   185.199.110.153
   A    @   185.199.111.153
   CNAME www <あなたのGitHubユーザー名>.github.io
   ```
3. Settings → Pages の **Custom domain** に `xn--ursw68l.com` を入れ、
   証明書が発行されたら **Enforce HTTPS** にチェックを入れます。

---

## ローカルで動かす

```bash
# public/config.js に接続先を書いたうえで
cd public && python3 -m http.server 8000
# → http://localhost:8000
```

`file://` で直接開くと ES モジュールが読み込めないので、簡易サーバ経由で開いてください。

## テスト

**データベース**（ローカルの PostgreSQL 上で、Supabase なしで動きます）

```bash
./supabase/tests/run.sh
```

権限まわり（匿名ユーザーが直接書き込めないこと、削除キーのハッシュが読めないこと）、
削除キーの照合、通報による自動非表示、削除時の後片付けなどを確認します。

**ブラウザ**（Supabase をモックに差し替えて画面の動きを見ます）

```bash
npm install -D playwright && npx playwright install chromium
node tests/browser/run.mjs
```

スクリーンショットが `tests/browser/screenshots/` に出ます。

---

## 安全面について

- **書き込みは全部サーバ側の関数（RPC）経由。** テーブルへの直接の INSERT / UPDATE / DELETE は
  匿名ユーザーには許可していません。文字数・画像パスの形式・投稿の間隔は
  すべて PostgreSQL 側で検証します。
- **削除キーは bcrypt でハッシュ化**して、匿名ユーザーからは読めないテーブルに保管します。
- **画像は canvas で描き直してから**アップロードするので、撮影場所などの Exif は残りません。
- **投稿ページに書き込まれた文字は、必ず文字として表示**します（HTML として解釈しません）。
- **通報が3人集まると自動で非表示。** しきい値は `supabase/schema.sql` の
  `report_content` 関数の `>= 3` で変えられます。

### 管理者としての削除

Supabase ダッシュボードの Table Editor で `posts` の行を消すと、
コメント・リアクション・削除キー・Storage 上の画像まで自動で片付きます。
とりあえず隠すだけなら `is_hidden` を `true` にしてください。

## ファイルの置き場所

```
public/           サイト本体（このフォルダがそのまま公開されます）
  index.html      画面の骨組み
  styles.css      見た目
  app.js          動き（Supabase とのやり取り全部）
  config.js       Supabase の接続先
supabase/
  schema.sql      データベースの定義。SQL Editor に貼るのはこれ
  tests/          スキーマのテスト
tests/browser/    画面のテスト
.github/workflows/deploy.yml   GitHub Pages への自動デプロイ
```

## 手を入れたくなったら

| やりたいこと | 場所 |
|---|---|
| リアクションの種類を変える | `public/app.js` の `KINDS` と `schema.sql` の `reactions_kind_valid` |
| 画像の大きさ・画質 | `public/app.js` の `MAX_EDGE` / `JPEG_QUALITY` |
| 色や雰囲気 | `public/styles.css` の先頭にある CSS 変数 |
| 投稿の上限（1時間10件） | `schema.sql` の `create_post` 関数 |
| 自動非表示のしきい値 | `schema.sql` の `report_content` 関数 |
