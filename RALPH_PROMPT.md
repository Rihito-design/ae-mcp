# 実装タスク

対象ファイル: /Users/s25981/Desktop/ae-mcp/index.js

## タスク1: `set_composition_settings` ツールを追加

既存コンポジションの設定を変更するツール。

パラメータ:
- `comp_name` (string, required) — 変更対象のコンポ名
- `width` (number, optional) — 幅(px)
- `height` (number, optional) — 高さ(px)
- `frame_rate` (number, optional) — フレームレート
- `duration` (number, optional) — デュレーション（秒）

ExtendScriptロジック:
- プロジェクト内から `comp_name` でCompItemを検索
- 見つからなければエラーを返す
- 指定されたパラメータだけ変更（未指定は変更しない）
- `app.beginUndoGroup("MCP: Set Composition Settings")` / `app.endUndoGroup()` を使う
- 変更後の値を return する

## タスク2: `add_layer_from_footage` の開始時間バグを修正

現在の実装:
```
var layer=comp.layers.add(footage,${time || 0});
```

第2引数はAE ExtendScriptではduration（レイヤーの長さ）であり、開始時間ではない。

修正後:
- `comp.layers.add(footage)` でレイヤーを追加
- `time` が指定された場合のみ `layer.startTime = time` で開始時間を設定

## 実装ルール

1. 既存ツールは壊さない
2. ExtendScriptはES3（`var`のみ、`let`/`const`/アロー関数不可）
3. エラーハンドリング必須
4. `app.beginUndoGroup()` / `app.endUndoGroup()` を状態変更操作に付ける
5. 実装後に `node --input-type=module --check < /Users/s25981/Desktop/ae-mcp/index.js` で構文チェック

## 完了条件

構文チェックがOKになったら `<promise>DONE</promise>` を出力する。
