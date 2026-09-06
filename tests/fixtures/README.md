# 検証専用の合成動画

`synthetic.webm` は `npm run test:fixture` で生成した5秒・320×180・24fpsのVP8動画です。毎秒違う背景色と移動する円だけをプログラムで描きます。個人の映像・音声・第三者素材は含みません。テスト用に利用・再生成できます。アプリの配布物へは含めません。

生成にはFFmpegのlibvpxエンコーダーが必要です。このPCでは既存のPlaywright同梱FFmpegを使用します。別環境はFFmpegをPATHへ置くか、`$env:TEST_FFMPEG_PATH` に実行ファイルを設定します。動画の変換機能をアプリに実装するものではありません。WebM試験はiPhoneのMOV/HEVC対応の証明ではありません。
