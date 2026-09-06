# AIレンジコーチの本人用分析 API

Cloudflare Worker と SQLite Durable Object 1個で、認証・重複送信防止・回数制限を処理します。Node.js 24 と npm を使用します。画面との契約・画像検証は `../shared/analysis.ts` で共用します。

```sh
npm ci
npm run typecheck
npm test
npm run dry-run
```

テストはローカルの workerd / SQLite Durable Object を起動します。OpenAI の通信だけをテスト応答へ差し替え、実 API は呼びません。Wrangler と同じ版の Miniflare を固定しています。テストにあるパスワード文字列は隔離テスト専用です。

公開前に Cloudflare の既存アカウントで `npx wrangler whoami` を確認してください。未認証なら本人が `npx wrangler login` を行います。Free プランで SQLite Durable Object が利用できることを確認し、Paid プランへの変更は行いません。

`APP_PASSWORD`（アプリ専用の24文字以上）と `OPENAI_API_KEY` は、本人が Cloudflare の Secrets に登録します。値をソース・ログ・画面・コマンド引数に書かず、Secret 入力プロンプトまたは管理画面を使用してください。

```sh
npx wrangler secret put APP_PASSWORD
npx wrangler secret put OPENAI_API_KEY
npm run deploy
```

未登録・モデル設定不一致の間は API を503で閉じます。`OPENAI_MODEL` は `gpt-5.6-terra`、本番 Origin は `https://metaborin.github.io` です。開発環境だけ localhost を許可します。`wrangler.jsonc` に認証情報やアカウントIDを含めません。`deploy` は実際の公開操作です。dry-run だけでは公開されません。

## API と保存期限

`POST /v1/analyses` と `GET /v1/analyses/{requestId}` の両方で `Authorization: Bearer <APP_PASSWORD>` が必要です。CORS はブラウザー側の制約であり、認証の代わりではありません。同一オリジンにある別アプリからの完全な分離も提供しません。認証失敗が5分内に10回に達すると、その窓が終わるまで認証を制限します。

要求ID・入力 fingerprint・日本時間の1日20回／月100回・同時1件の予約を同一の SQLite トランザクションで確定してから、OpenAI Responses を1回だけ呼びます。失敗でも予約済み回数を戻しません。通信期限は60秒です。成否不明時は再送せず `unknown` を返し、最大90秒のロック期限後に別の新規要求を受け付けます。

画像は実行中のメモリだけに置き、SQLite・ログへ保存しません。JSON本文は実際のストリームで6 MiBまで、4枚のJPEGは1枚1 MiB／合計4 MiB／長辺1280までです。外部画像URL・任意プロンプト・モデル指定は受け付けません。

結果JSONは最大10分で論理削除し、要求ID・fingerprint・状態の記録は要求作成時刻から24時間で削除します。Alarm と各受付時の清掃で期限を処理します。Alarm は再実行されても OpenAI を呼びません。Cloudflare 自体の運用上の保持は、アプリの論理削除とは別です。古いIDは時刻を検証して拒否するため、削除後も再分析されません。端末への結果保存に失敗しても、10分内は同じIDのGETだけで回収できます。

## 実行上の制限

入口 Worker は本文を解析せず、認証・画像の検証は Durable Object 内で行います。Cloudflare Free の入口CPU10 ms、DO CPU30秒、メモリ128 MiB等の制限があります。ネットワーク待機時間とCPU時間は別です。無料枠超過時の停止や障害を課金プランへの自動変更で回避しません。

- [Cloudflare Workers の制限](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects の制限](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects の料金・無料枠](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [SQLite transactionSync](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Alarm の実行と再試行](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [gpt-5.6-terra の対応機能](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
