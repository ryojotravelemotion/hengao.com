/* ---------------------------------------------------------------------
   Supabase の接続先。
   ここに書く anon キーは「公開してよいキー」です（ブラウザに配るためのもの）。
   実際のデータの守りは Supabase 側の RLS（supabase/schema.sql）で行っています。
   service_role キーは絶対にここに書かないでください。

   GitHub Actions でデプロイする場合は、リポジトリの Secrets に
   SUPABASE_URL / SUPABASE_ANON_KEY を登録すれば、このファイルは
   デプロイ時に自動で書き換わります。
   --------------------------------------------------------------------- */

window.HENGAO_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
};
