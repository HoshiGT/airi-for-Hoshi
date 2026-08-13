# AIRI for Hoshi

本分支 Fork 自 [moeru-ai/airi](https://github.com/moeru-ai/airi)，按个人偏好增加了许多新功能。

[English](#english) | [日本語](#日本語)

---

## 新增功能

### 聊天与记忆

- **记忆系统**：基于 PGlite 的本地记忆数据库，支持 LLM 自动整理（短期→长期沉淀）、手动增/删/改记忆条目、按角色卡隔离、整理偏好 Prompt 自定义、撤销上次整理。对话中的模型可通过工具实时查询和管理记忆。
- **聊天导入/导出**：导出时自动打包角色卡与记忆摘要，导入时一键还原。
- **聊天分支**：对话可分叉探索不同回复路径，侧边栏导航分支。
- **云同步开关**：登录状态下可选择仅本地存储，不上传聊天记录。

### 聊天渲染

- **QQ 式气泡**：表情包独立成条交错排列、段落分泡、会话抽屉导航。
- **表情包**：Airi 和用户都能发表情包，用户侧有选择器（插入输入框后手动发送）。
- **Markdown 渲染优化**：去重渲染器实例 + unified 单例复用。

### AI 大脑

- **Claude Code 大脑桥**：用 Claude Code 订阅额度作为 Airi 的大脑，本地 HTTP 桥接为 OpenAI 兼容端点。支持 prompt-cache session 复用（~10× 省钱）、工具直通、图片直通、思考折叠。
- **Claude Code 自动启动**：选择 Claude Code 作为模型时自动启动大脑服务，切走时自动停止，EADDRINUSE 自动复用。
- **MCP 工具审批**：人机协作工具执行，需用户确认后才执行敏感操作。

### Minecraft

- **MC 上下文优化**：普通事件不消耗 token，仅对话等主动事件进入大脑上下文；工具数 25→49 + 结构化失败反馈；噪音节流。
- **MC 视觉（look 工具）**：用原版材质无头渲染 bot 视野截图，支持跨版本方块状态翻译。
- **MC 自拍（selfie 工具）**：第三人称截图 + Mojang API 拉取真实皮肤替换。

### 桌面与系统

- **桌面控制**：Airi 可截取桌面画面并操控鼠标/键盘（xdotool 后端，Linux/X11）。
- **开机自启**：托盘菜单可设置随系统登录自动启动，启动时仅驻留托盘不弹窗。
- **端口固定**：Vite 开发端口强制锁定，不再因端口被占而跳转导致 IndexedDB 数据"消失"。
- **独显渲染**：Linux 桌面条目添加 PRIME offload 环境变量 + PrefersNonDefaultGPU。

### 集成

- **QQ 集成**：通过 NapCat/OneBot WebSocket 连接 QQ，实现消息收发。
- **中国象棋/国际象棋**：ffish 规则引擎 + 内置 alpha-beta 搜索（可接 Pikafish 引擎），中文棋谱记法，复盘评分。

---

<a id="english"></a>

## English

This branch is forked from [moeru-ai/airi](https://github.com/moeru-ai/airi) with many personal-preference features added.

### Chat & Memory

- **Memory system**: Local PGlite database with LLM-driven consolidation (short-term → long-term), manual add/edit/delete, per-character-card isolation, customizable consolidation prompts, and undo. The AI can query and manage memories in real time via tools.
- **Chat import/export**: Exports bundle character cards and memory snapshots; imports restore everything in one click.
- **Chat branching**: Fork conversations to explore different reply paths, with a sidebar for branch navigation.
- **Cloud sync toggle**: Stay signed in but keep all chats local-only.

### Chat Rendering

- **QQ-style bubbles**: Stickers rendered as standalone interleaved items, per-paragraph bubble splitting, session drawer navigation.
- **Stickers**: Both Airi and the user can send stickers; the user picks from a selector that inserts into the input box for editing before sending.
- **Markdown rendering optimization**: Deduplicated renderer instances + unified processor singleton.

### AI Brain

- **Claude Code brain bridge**: Use a Claude Code subscription as Airi's brain via a local OpenAI-compatible HTTP bridge. Supports prompt-cache session reuse (~10× cost reduction), tool passthrough, image passthrough, and thinking fold.
- **Claude Code auto-start**: The brain service starts automatically when the Claude Code provider is selected and stops when switching away; gracefully reuses an already-running instance.
- **MCP tool approval**: Human-in-the-loop tool execution — sensitive operations require user confirmation.

### Minecraft

- **MC context optimization**: Routine events don't consume tokens; only active events (chat, etc.) enter the brain context. Tool count 25→49 with structured failure feedback; noise throttling.
- **MC vision (look tool)**: Headless renderer with vanilla textures captures the bot's first-person view, with cross-version block-state translation.
- **MC selfie (selfie tool)**: Third-person screenshot with the bot's real skin fetched from the Mojang API.

### Desktop & System

- **Desktop control**: Airi can capture the screen and drive mouse/keyboard (xdotool backend, Linux/X11).
- **Open at login**: Tray menu option to auto-start with the system; launches silently to tray without showing the window.
- **Port pinning**: Vite dev port is locked so IndexedDB data never "disappears" from a port jump.
- **Discrete GPU**: Linux desktop entry includes PRIME offload env vars + PrefersNonDefaultGPU.

### Integrations

- **QQ integration**: Connect to QQ via NapCat/OneBot WebSocket for message send/receive.
- **Chinese chess / International chess**: ffish rule engine + built-in alpha-beta search (can connect Pikafish engine), Chinese notation, post-game review with engine grading.

---

<a id="日本語"></a>

## 日本語

このブランチは [moeru-ai/airi](https://github.com/moeru-ai/airi) からフォークし、個人の好みに合わせて多くの新機能を追加したものです。

### チャットと記憶

- **記憶システム**：PGlite ベースのローカル記憶データベース。LLM による自動整理（短期→長期沈殿）、手動での追加・編集・削除、キャラカード別の分離、整理プロンプトのカスタマイズ、前回の整理の取り消しに対応。対話中の AI がツールを通じてリアルタイムに記憶を検索・管理可能。
- **チャットのインポート/エクスポート**：エクスポート時にキャラカードと記憶のスナップショットを同梱、インポートでワンクリック復元。
- **チャット分岐**：会話を分岐させて異なる返答ルートを探索、サイドバーでブランチ間をナビゲート。
- **クラウド同期トグル**：ログイン中でもチャット履歴をローカルのみに保持可能。

### チャット描画

- **QQ スタイルのバブル**：スタンプが独立した行として交互表示、段落ごとのバブル分割、セッションドロワーナビゲーション。
- **スタンプ**：Airi とユーザーの両方がスタンプを送信可能。ユーザー側にはセレクタがあり、入力欄に挿入してから手動送信。
- **Markdown レンダリング最適化**：レンダラーインスタンスの重複排除 + unified プロセッサのシングルトン再利用。

### AI ブレイン

- **Claude Code ブレインブリッジ**：Claude Code のサブスクリプションを Airi のブレインとして利用。ローカルの OpenAI 互換 HTTP ブリッジ経由。プロンプトキャッシュによるセッション再利用（約10倍のコスト削減）、ツールパススルー、画像パススルー、思考フォールドに対応。
- **Claude Code 自動起動**：Claude Code プロバイダーを選択すると自動でブレインサービスが起動、切り替え時に自動停止。既に動作中のインスタンスは自動再利用。
- **MCP ツール承認**：ヒューマン・イン・ザ・ループのツール実行 — 機密操作はユーザーの確認後に実行。

### Minecraft

- **MC コンテキスト最適化**：通常のイベントはトークンを消費せず、チャットなどの能動的なイベントのみがブレインコンテキストに入る。ツール数 25→49、構造化された失敗フィードバック、ノイズスロットリング。
- **MC ビジョン（look ツール）**：バニラテクスチャによるヘッドレスレンダリングで bot の一人称視点をキャプチャ、クロスバージョンのブロックステート翻訳対応。
- **MC セルフィー（selfie ツール）**：Mojang API から取得した本物のスキンを使った三人称スクリーンショット。

### デスクトップとシステム

- **デスクトップ制御**：Airi が画面をキャプチャし、マウス/キーボードを操作可能（xdotool バックエンド、Linux/X11）。
- **ログイン時の自動起動**：トレイメニューからシステムログイン時の自動起動を設定可能。起動時はウィンドウを表示せずトレイに常駐。
- **ポート固定**：Vite 開発ポートをロックし、ポートジャンプによる IndexedDB データの「消失」を防止。
- **ディスクリート GPU**：Linux デスクトップエントリに PRIME オフロード環境変数 + PrefersNonDefaultGPU を追加。

### 連携

- **QQ 連携**：NapCat/OneBot WebSocket 経由で QQ に接続し、メッセージの送受信を実現。
- **中国将棋/チェス**：ffish ルールエンジン + 内蔵 alpha-beta 探索（Pikafish エンジン接続可）、中国語棋譜記法、対局後のエンジン採点付きレビュー。
