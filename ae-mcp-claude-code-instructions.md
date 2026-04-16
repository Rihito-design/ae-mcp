# ae-mcp 拡張実装指示

## 概要

`/Users/s25981/Desktop/ae-mcp/index.js` を拡張して、Adobe After Effects (Beta) をClaudeから操作できるツールを追加する。

既存の仕組みは以下の通り：
- Node.jsがExtendScriptをファイル(`/tmp/ae_mcp_script.jsx`)に書き出す
- `osascript -e 'tell application "Adobe After Effects (Beta)" to DoScript "$.evalFile(\"/tmp/ae_mcp_script.jsx\")"'` で実行
- 結果は `/tmp/ae_mcp_result.json` にExtendScriptが書き出す
- JSONシリアライズはExtendScript内の独自`toJSON()`関数を使う（`JSON`オブジェクト未定義のため）

既存ツール：
- `get_layers` — アクティブコンポのレイヤー一覧取得
- `add_keyframe` — トランスフォームキーフレーム追加

---

## 追加するツール

### 1. `create_composition`

新規コンポジションを作成する。

**パラメータ：**
- `name` (string, required) — コンポ名
- `width` (number, required) — 幅 (px)
- `height` (number, required) — 高さ (px)
- `frame_rate` (number, required) — フレームレート (例: 30)
- `duration` (number, required) — デュレーション（秒）

**ExtendScriptロジック：**
```javascript
var comp = app.project.items.addComp(name, width, height, 1, duration, frame_rate);
app.project.activeItem = comp;
return { compName: comp.name, width: comp.width, height: comp.height, frameRate: comp.frameRate, duration: comp.duration };
```

---

### 2. `set_layer_property`

レイヤーの基本プロパティを変更する。

**パラメータ：**
- `layer_name` (string, required) — レイヤー名（大文字小文字区別）
- `enabled` (boolean, optional) — 表示/非表示
- `solo` (boolean, optional) — ソロ
- `locked` (boolean, optional) — ロック
- `new_name` (string, optional) — レイヤー名変更

---

### 3. `add_keyframe` の拡張（既存ツールを修正）

既存の `add_keyframe` に速度補間（イージング）の設定を追加する。

**追加パラメータ：**
- `easing` (string, optional) — `"linear"` / `"ease"` / `"ease_in"` / `"ease_out"` / `"hold"`

**ExtendScriptロジック（キーフレーム設定後に補間を変更）：**
```javascript
var kfIndex = prop.nearestKeyIndex(time);
if (easing === "linear") {
    prop.setInterpolationTypeAtKey(kfIndex, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
} else if (easing === "ease") {
    prop.setInterpolationTypeAtKey(kfIndex, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
    prop.setEaseAtKey(kfIndex, [new KeyframeEase(0.5, 33.33)], [new KeyframeEase(0.5, 33.33)]);
} else if (easing === "ease_in") {
    prop.setInterpolationTypeAtKey(kfIndex, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.LINEAR);
} else if (easing === "ease_out") {
    prop.setInterpolationTypeAtKey(kfIndex, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.BEZIER);
} else if (easing === "hold") {
    prop.setInterpolationTypeAtKey(kfIndex, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
}
```

---

### 4. `set_keyframe_interpolation`

既存キーフレームの速度補間を変更する。

**パラメータ：**
- `layer_name` (string, required)
- `property` (string, required) — `"Position"` / `"Scale"` / `"Rotation"` / `"Opacity"` / `"Anchor Point"`
- `time` (number, required) — 対象キーフレームの時間（秒）
- `easing` (string, required) — `"linear"` / `"ease"` / `"ease_in"` / `"ease_out"` / `"hold"`

---

### 5. `relink_missing_footage`

リンク不明なフッテージを指定フォルダ以下から再帰検索して再リンクする。

**パラメータ：**
- `search_folder` (string, required) — 検索するフォルダのフルパス（例: `/Users/s25981/Desktop/assets`）

**ExtendScriptロジック：**
```javascript
function findFile(folderPath, targetName) {
    var f = new Folder(folderPath);
    var files = f.getFiles();
    for (var i = 0; i < files.length; i++) {
        if (files[i] instanceof File && files[i].name === targetName) return files[i];
        if (files[i] instanceof Folder) {
            var found = findFile(files[i].fsName, targetName);
            if (found) return found;
        }
    }
    return null;
}

var relinked = [];
var failed = [];
for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    if (item instanceof FootageItem && item.footageMissing) {
        var found = findFile(search_folder, item.name);
        if (found) {
            item.replace(found);
            relinked.push(item.name);
        } else {
            failed.push(item.name);
        }
    }
}
return { relinked: relinked, failed: failed };
```

---

### 6. `render_composition`

指定コンポジションをレンダリングして固定フォルダに保存する。

**書き出し先は `/Users/s25981/Desktop/ae_renders` に固定。**

**事前処理：** Node.js側で `/Users/s25981/Desktop/ae_renders` フォルダが存在しない場合は `fs.mkdir` で自動作成する。

**パラメータ：**
- `comp_name` (string, required) — レンダリング対象のコンポ名
- `output_name` (string, optional) — ファイル名（省略時はコンポ名。拡張子不要）
- `format` (string, optional) — `"h264"` / `"png_sequence"` / `"avi"` （デフォルト: `"h264"`）

**ExtendScriptロジック：**
```javascript
var OUTPUT_FOLDER = "/Users/s25981/Desktop/ae_renders";
var comp = null;
for (var i = 1; i <= app.project.numItems; i++) {
    if (app.project.item(i) instanceof CompItem && app.project.item(i).name === comp_name) {
        comp = app.project.item(i);
        break;
    }
}
if (!comp) return { error: "Composition not found: " + comp_name };
var rqItem = app.project.renderQueue.items.add(comp);
var outputModule = rqItem.outputModules[1];
var fileName = (output_name || comp_name) + ".mp4";
outputModule.file = new File(OUTPUT_FOLDER + "/" + fileName);
app.project.renderQueue.render();
return { status: "render_started", outputPath: OUTPUT_FOLDER + "/" + fileName };
```

---

## 実装上の注意点

1. **`toJSON()`関数は全スクリプトに必ず含める** — ExtendScriptに`JSON`オブジェクトはない
2. **スクリプトはすべて1ファイルにまとめる** — `runExtendScript()`の仕組みを変えない
3. **エラーハンドリングを必ず実装** — AE側のエラーは`try/catch`でキャッチして`writeResult({success:false,...})`で返す
4. **`app.beginUndoGroup()` / `app.endUndoGroup()`** — 状態変更を伴う操作には必ず付ける
5. **既存ツールは壊さない** — `get_layers`と`add_keyframe`の既存挙動を維持する
6. **`render_composition`の書き出し先は固定** — `/Users/s25981/Desktop/ae_renders` 以外には書き出さない

---

## 実装完了後の確認事項

- `get_layers` が引き続き動作すること
- `create_composition` でコンポが作られること
- `add_keyframe` にeasingを指定してキーフレームが打てること
- `set_keyframe_interpolation` で補間が変更できること
- `relink_missing_footage` でリンク切れが修復されること
- `render_composition` で `/Users/s25981/Desktop/ae_renders` にファイルが書き出されること
