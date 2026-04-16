# ae-mcp v2 拡張実装指示（ラルフループ用）

## このドキュメントの使い方

ラルフループで実行する。各フェーズを順番に完走し、全テストが通ったら `<promise>DONE</promise>` を出力すること。

---

## 対象ファイル

`/Users/s25981/Desktop/ae-mcp/index.js`

---

## 既存の仕組み（変えないこと）

- Node.jsがExtendScriptを `/tmp/ae_mcp_script.jsx` に書き出す
- `osascript -e 'tell application "Adobe After Effects (Beta)" to DoScript "$.evalFile(\"/tmp/ae_mcp_script.jsx\")"'` で実行
- 結果は `/tmp/ae_mcp_result.json` にExtendScriptが書き出す
- JSONシリアライズは `toJSON()` 独自実装を使う（ExtendScriptにJSONオブジェクトなし）
- `runExtendScript(script)` 関数でスクリプト実行 → JSON結果を返す

**既存ツール（壊さないこと）：**
- `get_layers` / `create_composition` / `set_layer_property`
- `add_keyframe`（easing付き）/ `set_keyframe_interpolation`
- `relink_missing_footage` / `render_composition`

---

## フェーズ1：プロジェクト情報系ツール

### `list_compositions`

プロジェクト内の全コンポジション一覧を取得する。

**パラメータ：** なし

**ExtendScriptロジック：**
```javascript
var comps = [];
for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem) {
        comps.push({
            index: i,
            name: item.name,
            width: item.width,
            height: item.height,
            frameRate: item.frameRate,
            duration: item.duration,
            numLayers: item.numLayers
        });
    }
}
return { compositions: comps };
```

### `get_project_items`

プロジェクトパネル内の全アイテム（フッテージ・フォルダ・コンポ）一覧を取得する。

**パラメータ：** なし

**ExtendScriptロジック：**
```javascript
var items = [];
for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    var type = "Unknown";
    if (item instanceof CompItem) type = "Comp";
    else if (item instanceof FolderItem) type = "Folder";
    else if (item instanceof FootageItem) type = "Footage";
    items.push({
        index: i,
        name: item.name,
        type: type,
        missing: (item instanceof FootageItem) ? item.footageMissing : false
    });
}
return { items: items };
```

**フェーズ1完了条件：** `list_compositions` と `get_project_items` がAEで動作すること

---

## フェーズ2：レイヤー作成系ツール

### `create_text_layer`

テキストレイヤーを新規作成する。

**パラメータ：**
- `text` (string, required) — テキスト内容
- `font_size` (number, optional, default: 36) — フォントサイズ
- `color` (array, optional, default: [1,1,1]) — RGB 0〜1の配列 例: [1,0,0] = 赤
- `position` (array, optional) — [x, y] ピクセル座標

**ExtendScriptロジック：**
```javascript
var comp = app.project.activeItem;
if (!comp || !(comp instanceof CompItem)) return { error: "No active composition." };
app.beginUndoGroup("MCP: Create Text Layer");
var textLayer = comp.layers.addText(text);
var textProp = textLayer.property("Source Text");
var textDoc = textProp.value;
textDoc.fontSize = fontSize || 36;
if (color) textDoc.fillColor = color;
textProp.setValue(textDoc);
if (position) textLayer.transform.position.setValue(position);
app.endUndoGroup();
return { success: true, layerName: textLayer.name, index: textLayer.index };
```

### `create_shape_layer`

シェイプレイヤーを新規作成する。

**パラメータ：**
- `shape` (string, required) — `"rectangle"` / `"ellipse"`
- `name` (string, optional) — レイヤー名
- `width` (number, optional, default: 100)
- `height` (number, optional, default: 100)
- `position` (array, optional) — [x, y]
- `fill_color` (array, optional, default: [1,1,1]) — RGB 0〜1

**ExtendScriptロジック：**
```javascript
var comp = app.project.activeItem;
if (!comp || !(comp instanceof CompItem)) return { error: "No active composition." };
app.beginUndoGroup("MCP: Create Shape Layer");
var shapeLayer = comp.layers.addShape();
if (name) shapeLayer.name = name;
var contents = shapeLayer.property("Contents");
var grp = contents.addProperty("ADBE Vector Group");
var grpContents = grp.property("Contents");
if (shape === "ellipse") {
    var ellipse = grpContents.addProperty("ADBE Vector Shape - Ellipse");
    ellipse.property("Size").setValue([w, h]);
} else {
    var rect = grpContents.addProperty("ADBE Vector Shape - Rect");
    rect.property("Size").setValue([w, h]);
}
var fill = grpContents.addProperty("ADBE Vector Graphic - Fill");
fill.property("Color").setValue(fillColor || [1,1,1]);
if (position) shapeLayer.transform.position.setValue(position);
app.endUndoGroup();
return { success: true, layerName: shapeLayer.name, index: shapeLayer.index };
```

### `create_solid_layer`

ソリッドまたは調整レイヤーを作成する。

**パラメータ：**
- `name` (string, required)
- `width` (number, optional) — 省略時はコンポサイズ
- `height` (number, optional) — 省略時はコンポサイズ
- `color` (array, optional, default: [0,0,0]) — RGB 0〜1
- `is_adjustment` (boolean, optional, default: false) — 調整レイヤーにする

**ExtendScriptロジック：**
```javascript
var comp = app.project.activeItem;
app.beginUndoGroup("MCP: Create Solid");
var solid = comp.layers.addSolid(
    color || [0,0,0],
    name,
    width || comp.width,
    height || comp.height,
    comp.pixelAspect
);
if (isAdjustment) solid.adjustmentLayer = true;
app.endUndoGroup();
return { success: true, layerName: solid.name, index: solid.index };
```

### `add_layer_from_footage`

プロジェクトアイテムをアクティブコンポのタイムラインに追加する。

**パラメータ：**
- `item_name` (string, required) — プロジェクトパネル内のアイテム名（大文字小文字区別）
- `position` (array, optional) — 配置後の [x, y] 座標
- `time` (number, optional, default: 0) — 配置するタイムの位置（秒）

**ExtendScriptロジック：**
```javascript
var comp = app.project.activeItem;
var footage = null;
for (var i = 1; i <= app.project.numItems; i++) {
    if (app.project.item(i).name === itemName) {
        footage = app.project.item(i);
        break;
    }
}
if (!footage) return { error: "Item not found: " + itemName };
app.beginUndoGroup("MCP: Add Layer from Footage");
var layer = comp.layers.add(footage, time || 0);
if (position) layer.transform.position.setValue(position);
app.endUndoGroup();
return { success: true, layerName: layer.name, index: layer.index };
```

**フェーズ2完了条件：** 4つのレイヤー作成ツールがAEで動作すること

---

## フェーズ3：Illustratorファイルインポート連携

### `import_footage`

外部ファイル（.ai / .png / .psd / .mp4 など）をプロジェクトにインポートする。

**パラメータ：**
- `file_path` (string, required) — インポートするファイルのフルパス
- `import_as_comp` (boolean, optional, default: false) — .ai/.psd をコンポジションとして展開するか
- `target_folder` (string, optional) — プロジェクトパネルの格納先フォルダ名

**Node.js側の前処理：** `fs.access(filePath)` でファイルの存在確認。なければエラーを返す。

**ExtendScriptロジック：**
```javascript
var importOptions = new ImportOptions(new File(filePath));
if (importAsComp) {
    importOptions.importAs = ImportAsType.COMP;
} else {
    importOptions.importAs = ImportAsType.FOOTAGE;
}
app.beginUndoGroup("MCP: Import Footage");
var item = app.project.importFile(importOptions);

// フォルダ指定がある場合は移動
if (targetFolder) {
    for (var i = 1; i <= app.project.numItems; i++) {
        var f = app.project.item(i);
        if (f instanceof FolderItem && f.name === targetFolder) {
            item.parentFolder = f;
            break;
        }
    }
}
app.endUndoGroup();
return {
    success: true,
    itemName: item.name,
    itemIndex: item.id,
    type: (item instanceof CompItem) ? "Comp" : "Footage"
};
```

**Illustratorファイルを使う典型的なワークフロー：**
1. `import_footage` でAIファイルをコンポとしてインポート（import_as_comp: true）
2. `get_project_items` でインポートされたアイテムを確認
3. `add_layer_from_footage` でパーツをコンポに配置
4. `add_keyframe` でアニメーション

**フェーズ3完了条件：** `import_footage` でAIファイルをインポートしてコンポに展開できること

---

## フェーズ4：エフェクト系ツール

### `apply_effect`

レイヤーにエフェクトを適用する。

**パラメータ：**
- `layer_name` (string, required)
- `effect_name` (string, required) — エフェクト名 例: `"Gaussian Blur"` / `"Drop Shadow"`
- `properties` (object, optional) — 適用後に設定するプロパティ名と値のマップ

**ExtendScriptロジック：**
```javascript
var comp = app.project.activeItem;
var layer = null;
for (var i = 1; i <= comp.numLayers; i++) {
    if (comp.layer(i).name === layerName) { layer = comp.layer(i); break; }
}
if (!layer) return { error: "Layer not found: " + layerName };
app.beginUndoGroup("MCP: Apply Effect");
var effect = layer.property("Effects").addProperty(effectName);
if (!effect) return { error: "Effect not found: " + effectName };
// propertiesがある場合は設定
app.endUndoGroup();
return { success: true, effectName: effect.name };
```

### `set_expression`

プロパティにエクスプレッションを設定する。

**パラメータ：**
- `layer_name` (string, required)
- `property` (string, required) — `"Position"` / `"Scale"` / `"Rotation"` / `"Opacity"`
- `expression` (string, required) — エクスプレッション文字列

**ExtendScriptロジック：**
```javascript
prop.expression = expression;
return { success: true, expression: prop.expression };
```

**フェーズ4完了条件：** `apply_effect` と `set_expression` が動作すること

---

## フェーズ5：動作確認・統合テスト

以下を順番に実行して全て成功することを確認：

1. `list_compositions` → コンポ一覧が返る
2. `get_project_items` → プロジェクトアイテム一覧が返る
3. `create_text_layer` で "Hello" テキストを作成
4. `create_solid_layer` で赤いソリッドを作成
5. `import_footage` でデスクトップのAIファイル（存在しない場合はPNGで代替）をインポート
6. `add_layer_from_footage` でインポートしたアイテムをコンポに追加
7. `apply_effect` でGaussian Blurをかける
8. 既存の `get_layers` / `add_keyframe` が引き続き動作すること

全テスト通過後 `<promise>DONE</promise>` を出力。

---

## 実装上の注意点

1. **`toJSON()`は全スクリプトに必ず含める** — 既存実装を流用するだけでOK
2. **ExtendScriptはES3相当** — `let`/`const`/アロー関数は使わない。`var`のみ
3. **エラーハンドリング必須** — 全スクリプトに`try/catch`
4. **`app.beginUndoGroup()` / `app.endUndoGroup()`** — 状態変更操作には必ず付ける
5. **既存ツールは壊さない** — 既存の7ツールの挙動を維持する
6. **スクリプトは1行に圧縮** — `runExtendScript()` に渡す前に改行を除去する

---

## ラルフループ進め方

- フェーズ1 → 動作確認 → フェーズ2 → 動作確認 → ... と順番に進む
- エラーが出たら次のイテレーションで自己修正する
- `node --input-type=module --check < index.js` で構文チェックを各フェーズ後に実行
- 全フェーズ完了したら `<promise>DONE</promise>` を出力
