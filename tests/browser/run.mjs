/* =====================================================================
   変顔.com  ブラウザテスト
   Supabase をモックに差し替えて、画面の動きをひと通り確認する。
     準備:  npm install -D playwright   （または playwright がグローバルにある環境）
     実行:  node tests/browser/run.mjs
   スクリーンショットは tests/browser/screenshots/ に出る。
   ===================================================================== */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const ROOT = fileURLToPath(new URL('../../public', import.meta.url));
const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));
const MOCK = readFileSync(new URL('./mock-supabase.js', import.meta.url), 'utf8');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
                '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };

// 1x1 の PNG（画像プレースホルダ用）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

mkdirSync(SHOTS, { recursive: true });

const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  if (path.startsWith('/mock-image')) {
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return;
  }
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(4321, r));

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'テスト' : undefined));

// CDN の supabase-js をモックに差し替える
await page.route('**/cdn.jsdelivr.net/**', (route) =>
  route.fulfill({ status: 200, contentType: 'text/javascript', body: MOCK }));

// --------------------------------------------------------------- 未設定の画面
// 公開先（localhost 以外）で接続先が未設定なら、設定手順の案内を出す
const serveFromDisk = (route) => {
  const path = decodeURIComponent(new URL(route.request().url()).pathname);
  try {
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    route.fulfill({
      status: 200,
      contentType: TYPES[extname(file)] ?? 'application/octet-stream',
      body: readFileSync(file),
    });
  } catch { route.fulfill({ status: 404, body: 'not found' }); }
};
await page.route('http://hengao.example/**', serveFromDisk);
await page.goto('http://hengao.example/', { waitUntil: 'networkidle' });
check('公開先で設定が未入力なら案内画面が出る', await page.locator('#view-setup').isVisible());
check('公開先ではお試しモードにならない', (await page.locator('.demo-note').count()) === 0);

// --------------------------------------------------------------- 設定済みの画面
// config.js を「設定済み」の内容に差し替える
await page.route('**/config.js', (route) => route.fulfill({
  status: 200, contentType: 'text/javascript',
  // Project URL と間違えて REST のエンドポイントを貼った状態を再現する
  body: 'window.HENGAO_CONFIG = { supabaseUrl: "https://example.supabase.co/rest/v1/", supabaseAnonKey: "anon-test-key" };',
}));
await page.goto('http://localhost:4321/', { waitUntil: 'networkidle' });

check('Project URL を取り違えても接続先が直される',
      (await page.evaluate(() => window.__clientArgs?.url)) === 'https://example.supabase.co',
      await page.evaluate(() => window.__clientArgs?.url));

await page.waitForSelector('.card');
check('一覧に投稿が並ぶ', (await page.locator('.card').count()) === 3,
      `${await page.locator('.card').count()} 件`);
check('キャプションが無い投稿も落ちずに出る', (await page.locator('.card-caption').count()) === 2);
check('画像に alt が入っている',
      (await page.locator('.card img').first().getAttribute('alt')) === '渾身の1枚目');

// 並び替え
await page.locator('.tab[data-sort="best"]').click();
await page.waitForTimeout(150);
check('タブを押すと選択状態が移る',
      (await page.locator('.tab[data-sort="best"]').getAttribute('aria-selected')) === 'true');
await page.locator('.tab[data-sort="new"]').click();
await page.waitForTimeout(150);

// --------------------------------------------------------------- 詳細画面
await page.locator('.card-media').first().click();
await page.waitForSelector('.detail');
check('カードから詳細に移動できる', await page.locator('#view-post').isVisible());
check('リアクションが4種類ある', (await page.locator('.reaction').count()) === 4);
check('既存のコメントが表示される',
      (await page.locator('.comment-body').first().textContent()) === 'くっそわろた');

// リアクション
const warota = page.locator('.reaction').first();
await warota.click();
await page.waitForTimeout(200);
check('リアクションを押すと押下状態になる',
      (await warota.getAttribute('aria-pressed')) === 'true');
check('リアクション数が増える', (await warota.locator('.count').textContent()) === '4');
await warota.click();
await page.waitForTimeout(200);
check('もう一度押すと取り消せる',
      (await warota.getAttribute('aria-pressed')) === 'false'
      && (await warota.locator('.count').textContent()) === '3');

// コメント投稿
await page.locator('.comment-form textarea').fill('これはひどい（褒め言葉）');
await page.locator('.comment-form input[type="text"]').fill('テスト太郎');
await page.locator('.comment-form button[type="submit"]').click();
await page.waitForTimeout(400);
check('コメントを投稿すると一覧に増える', (await page.locator('.comment').count()) === 2);
check('コメントの名前が反映される',
      (await page.locator('.comment .name').last().textContent()) === 'テスト太郎');
check('自分のコメントには削除ボタンが出る',
      (await page.locator('.comment').last().locator('.link-btn', { hasText: '削除' }).count()) === 1);

// XSS を試す
await page.locator('.comment-form textarea').fill('<img src=x onerror="window.__xss=1">');
await page.locator('.comment-form button[type="submit"]').click();
await page.waitForTimeout(400);
check('コメントの HTML はそのまま文字として出る（XSS しない）',
      (await page.evaluate(() => window.__xss)) === undefined
      && (await page.locator('.comment-body').last().textContent()).includes('<img src=x'));

// 自分のコメントを削除
await page.locator('.comment').last().locator('.link-btn', { hasText: '削除' }).click();
await page.waitForTimeout(400);
check('自分のコメントを削除できる', (await page.locator('.comment').count()) === 2);

// --------------------------------------------------------------- 投稿する
await page.goBack();
await page.waitForSelector('#view-timeline:not([hidden])');
await page.locator('[data-action="open-composer"]').first().click();
check('投稿ダイアログが開く', await page.locator('#composer').isVisible());

// 大きめの JPEG を選ばせて、縮小されるか見る
const bigImage = await page.evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 3000; canvas.height = 2000;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffce2b'; ctx.fillRect(0, 0, 3000, 2000);
  ctx.fillStyle = '#000'; ctx.font = '400px sans-serif'; ctx.fillText('(ﾟ∀ﾟ)', 300, 1200);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  const buffer = new Uint8Array(await blob.arrayBuffer());
  return Array.from(buffer);
});
await page.setInputFiles('#file-input', {
  name: 'hengao.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bigImage),
});
await page.waitForSelector('#preview:not([hidden])');
check('写真を選ぶと案内文がプレビューに置き換わる',
      (await page.locator('#preview').isVisible())
      && !(await page.locator('#dropzone-empty').isVisible()));
const note = await page.locator('#image-note').textContent();
check('選んだ画像が長辺1400pxに縮小される', note.startsWith('1400×933'), note);

// 同意チェック無しでは投稿できない（ブラウザ標準の検証で止まる）
await page.locator('#caption').fill('テスト投稿です');
await page.locator('#submit-post').click();
await page.waitForTimeout(200);
check('同意チェックが無いと投稿できない',
      await page.locator('#composer').isVisible()
      && (await page.evaluate(() => (window.__uploads ?? []).length)) === 0
      && (await page.evaluate(() => document.querySelector('#consent').validity.valid)) === false);

// 短すぎる削除キーも同様に止まる
await page.locator('#consent').check();
await page.locator('#delete-key').fill('ab');
await page.locator('#submit-post').click();
await page.waitForTimeout(200);
check('4文字未満の削除キーは弾かれる',
      (await page.evaluate(() => document.querySelector('#delete-key').validity.valid)) === false
      && (await page.evaluate(() => (window.__uploads ?? []).length)) === 0);

// 削除キーを空にすれば自動生成される
await page.locator('#delete-key').fill('');
await page.locator('#nickname').fill('テスト花子');
await page.locator('#submit-post').click();
await page.waitForSelector('#done-dialog[open]');
const shownKey = await page.locator('#done-key').textContent();
check('投稿が完了して削除キーが表示される', shownKey.length === 8, `キー: ${shownKey}`);

const uploads = await page.evaluate(() => window.__uploads);
check('画像は JPEG としてアップロードされる', uploads[0].type === 'image/jpeg');
check('保存パスが 年/月/UUID.jpg の形',
      /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/.test(uploads[0].path), uploads[0].path);
check('サーバ側の形式チェックにも通るパス',
      /^[0-9]{4}\/[0-9]{2}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$/.test(uploads[0].path));

await page.locator('#done-dialog [data-action="close-done"].btn').click();
await page.waitForTimeout(400);
check('投稿後、一覧が最新に更新される', (await page.locator('.card').count()) === 4);
check('新しい投稿が先頭に来る',
      (await page.locator('.card-caption').first().textContent()) === 'テスト投稿です');

// 自分の投稿には削除ボタンが出る
await page.locator('.card-media').first().click();
await page.waitForSelector('.detail');
check('自分の投稿には削除ボタンが出る',
      (await page.locator('.link-btn', { hasText: '自分の投稿を削除' }).count()) === 1);

// スクリーンショット
const shot = (name) => page.screenshot({ path: SHOTS + `${name}.png` });
await shot('detail');
await page.goto('http://localhost:4321/', { waitUntil: 'networkidle' });
await page.waitForSelector('.card');
await page.locator('[data-action="open-composer"]').first().click();
await page.waitForTimeout(300);
await shot('composer');
await page.locator('#composer [data-action="close-composer"].icon-btn').click();
await page.waitForTimeout(200);
await page.waitForSelector('.card');
await page.screenshot({ path: SHOTS + 'timeline.png', fullPage: false });
await page.emulateMedia({ colorScheme: 'dark' });
await page.screenshot({ path: SHOTS + 'timeline-dark.png' });
await page.emulateMedia({ colorScheme: 'light' });
await page.setViewportSize({ width: 390, height: 780 });
await page.screenshot({ path: SHOTS + 'mobile.png' });

check('コンソールエラーが出ていない', consoleErrors.length === 0, consoleErrors.join(' | '));

// --------------------------------------------------------------- お試しモード
// 接続先が未設定でも、手元（localhost）でなら中身を触れること
const demo = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const demoPage = await demo.newPage();
const demoErrors = [];
demoPage.on('console', (m) => { if (m.type() === 'error') demoErrors.push(m.text()); });
demoPage.on('pageerror', (e) => demoErrors.push(`pageerror: ${e.message}`));

await demoPage.goto('http://localhost:4321/', { waitUntil: 'networkidle' });
check('手元で開くとお試しモードになる', await demoPage.locator('.demo-note').isVisible());
check('お試しモードでも一覧が出る', await demoPage.locator('#view-timeline').isVisible());

await demoPage.locator('[data-action="open-composer"]').first().click();
await demoPage.setInputFiles('#file-input', {
  name: 'hengao.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bigImage),
});
await demoPage.waitForSelector('#preview:not([hidden])');
await demoPage.locator('#caption').fill('お試しモードの投稿');
await demoPage.locator('#consent').check();
await demoPage.locator('#submit-post').click();
await demoPage.waitForSelector('#done-dialog[open]', { timeout: 15000 });
await demoPage.locator('#done-dialog [data-action="close-done"].btn').click();
await demoPage.waitForTimeout(500);
check('お試しモードで投稿できる', (await demoPage.locator('.card').count()) === 1);

await demoPage.reload({ waitUntil: 'networkidle' });
await demoPage.waitForTimeout(600);
check('お試しモードの投稿はブラウザに残る',
      (await demoPage.locator('.card-caption').first().textContent()) === 'お試しモードの投稿');
check('お試しモードでコンソールエラーが出ていない', demoErrors.length === 0, demoErrors.join(' | '));
await demo.close();

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 合格`);
process.exit(failed.length ? 1 : 0);
