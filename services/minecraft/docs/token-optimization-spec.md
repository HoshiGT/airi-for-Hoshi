# Minecraft Bot Token/轮数优化 —— 需求说明

> 状态：**P0 已实施**（2026-07-26）· 编写日期 2026-07-26
>
> 实施结果见文末「附录 C：实施记录」。P1/P2 未做。

## 0. 怎么用这份文档

执行者拿到这份文档时**没有前置对话上下文**。所有结论都带了文件坐标，请先自行验证再动手 —— 文档里明确区分了两类信息：

- **【实测】** = 本人执行过命令/脚本得到的数字，可复现（复现方法见附录 A）
- **【读码】** = 从源码推断，**未在运行中的 bot 上观测过**

这个服务当前**没有被配置过**：`services/minecraft/.env` 是未修改的模板（`OPENAI_API_BASEURL` / `OPENAI_API_KEY` 为空），无 `.env.local`，无 `data/minecraft-config.json`。也就是说**没有任何真实运行数据**，所有频率结论都是【读码】。执行前如果能先跑起来采一轮真实数据，价值很大。

## 1. 背景

`services/minecraft` 是 AIRI 的 Minecraft bot（Mineflayer + 四层认知架构：Perception → Reflex → Conscious → Action）。Conscious 层是唯一花钱的地方：每个被"升级到意识层"的事件 = 一次完整 LLM 调用。

优化目标按重要性排序：

1. **减少 LLM 轮数**（每轮都是一次完整往返，成本随历史线性增长）
2. **保住 prompt 缓存**（缓存在时，体积不是主要矛盾，轮数才是）
3. 减少无效 CPU / 磁盘开销

⚠️ 注意 `README.md` 顶部的弃用声明：本服务在迁移到 Fabric mod 运行时的路径上。**所有改动应控制在"小而可回收"的范围**，不要为它新建大型子系统。

## 2. 核实过的事实

### 2.1 LLM 调用侧

| 事实 | 坐标 | 来源 |
|---|---|---|
| 全服务只有**一个** LLM 调用点 | `src/cognitive/conscious/brain.ts:1898` | 读码 |
| system prompt = **37,721 字符**（无 master）/ 38,702（有 master） | `prompts/brain-prompt.ts` | **实测** |
| 其中模板本体 31,937 字符，25 个工具签名只占 **5,784 字符（15%）** | 同上 | **实测** |
| 每个工具平均 **231 字符 ≈ 58 tokens**，每轮都发 | 同上 | **实测** |
| 模板里 `## Input + Runtime Log Objects` 10,870 字符 + `## Query DSL` 4,962 字符 = **40%** | `prompts/brain-prompt.md` | **实测** |
| 历史上限 200 条消息，**从不摘要** | `brain.ts:231` (`MAX_CONVERSATION_HISTORY_MESSAGES`) | 读码 |
| 到上限后**每轮 `slice` 砍掉最前 2 条** | `brain.ts:2070-2073` | 读码 |
| assistant 消息带 `reasoning` 字段存进历史并**原样回传** | `brain.ts:2062-2066`；xsai 直接把 messages 塞进请求体 | 读码 |
| `OPENAI_REASONING_MODEL` 已配置、已校验、**全代码库无人使用** | `composables/config.ts:40,120` | 读码 |

### 2.2 缓存机制（claude-code-brain，D1 已确定采用）

`services/claude-code-brain/src/sessions.ts:42-56`：

- session lookup key = **所有 user 轮文本的 sha256**（除最新一条），不看 assistant 回复
- MC 大脑输出**纯文本 JS 代码**、不走 `tool_calls` → `decideStrategy` 的"tool 轮退回 fresh"规则碰不到它 → **永远走得上 resume 路径**（有利）
- **但**：历史一到 200 条开始砍前 2 条，user 序列头部改变 → hash 变 → **从此每轮 fresh 全量重放，缓存永久失效**

### 2.3 唤醒频率（每次 = 至少一次 LLM 调用）

| 触发源 | 规则 | 节流 |
|---|---|---|
| 玩家聊天 | `cognitive/index.ts:118` | ❌ 无（任何玩家，不限主人） |
| 服务器系统消息 | `perception/rules/system-message.yaml` threshold 1 / 1s **sliding** | ❌ 每条一轮 |
| 受伤 | `perception/rules/danger/damage.yaml` threshold 1 / 500ms **sliding** | ❌ 每次掉血一轮 |
| 低血量 | `events/definitions/low-health.ts:13` | ✅ 已做边沿锁存（**可作为其它规则的范本**） |
| 蹲起挑衅 | `rules/social/teabag.yaml` | ✅ |
| 玩家走动 | `rules/attention/movement.yaml` | ✅ 被 `reflex-manager.ts:32` 挡在意识层外 |

> `sliding` 是 loader 默认值（`rules/loader.ts:63`），threshold=1 时**每个事件都会触发**。烧着/岩浆/溺水 = 持续每秒 1~2 轮。

三个放大器：
- `chat({feedback:true})` 完成后再入队一个 feedback 事件 → 又一轮（`brain.ts:392`）
- no-action 自动追问，默认 **×3，最多 ×8**（`brain.ts:232-233`）
- 失败重试，每次 60s 超时（`brain.ts:236`）

### 2.4 Skill 覆盖度

**`skills/` 导出 79 个能力，暴露给 LLM 的只有 25 个。**

已暴露的 25 个：
```
chat giveUp skip stop goToPlayer followPlayer clearFollowTarget goToCoordinate
givePlayer consume equip putInChest takeFromChest discard collectBlocks
mineBlockAt craftRecipe smeltItem clearFurnace placeHere attack attackPlayer
goToBed activate recipePlan
```

写好了但模型看不见的（重点）：

| 能力 | 位置 | 说明 |
|---|---|---|
| `ensure*` **14 个** | `skills/actions/ensure.ts` | 造镐/剑/斧/锹/锄、火把、箱子、熔炉、营火、工作台、木板、木棍、圆石、煤 |
| `goToNearestEntity` / `goToNearestBlock` | `skills/movement.ts:116,91` | **见下方高优先说明** |
| `tillAndSow` | `blocks.ts:447` **和** `world-interactions.ts:359` | 整个农业；**两份实现** |
| `placeBlock`（指定坐标） | `blocks.ts:95` **和** `world-interactions.ts:29` | 已暴露的 `placeHere` 只能放脚下；**两份实现** |
| `gatherWood` | `skills/actions/gather-wood.ts:21` | |
| `useDoor` / `moveAway` / `moveAwayFromEntity` | `blocks.ts:380` / `movement.ts:223` | |
| `organizeInventory` / `transferAllToChest` / `viewChest` | `skills/actions/inventory.ts` 等 | |
| `pickupNearbyItems` / `stay` / `defendSelf` | | |

**`goToNearestEntity` 未暴露是最值得先修的一个**：模型想接近一只猪只能自己写
`query.entities().whereName("pig").first().pos.x`，而 `brain.ts:246` 的 `augmentDecisionError` 注释明确记录了这个模式会"重复同样的崩溃好几轮然后放弃" —— 专门写了错误增强器兜底。暴露这一个函数即可消掉一整类烧轮。

⚠️ **重复实现**：`placeBlock` 和 `tillAndSow` 在 `skills/blocks.ts` 与 `skills/actions/world-interactions.ts` 各有一份，**两份都在被使用**：
- `world-interactions.placeBlock` ← `cognitive/action/llm-actions.ts:9`
- `blocks.placeBlock` ← `skills/crafting.ts:15`

暴露前必须先决定保留哪份，否则会把分歧固化。

### 2.5 现有 combat 能力（用于校准"要不要造新 skill"）

`attack({ type: "pig" })` → `attackNearest` → `attackEntity`（`skills/combat.ts`）已经做了：
- 48 格搜索 + `GoalNear` 靠近
- `equipHighestAttack`：按 attackDamage 选最强剑/斧，无则退化到镐/锹
- 攻击间隔：mineflayer-pvp 的 `TimingSolver` + `AttackSpeeds.json`，按武器算 cooldown
- 追击：pvp 内置
- **杀完 `collectNearbyDrops` 自动捡肉**，并处理了"掉落物延迟数百 ms 才 spawn"的坑

**唯一缺的是暴击**（跳起落地时攻击）—— mineflayer-pvp 无暴击逻辑（`grep critical|jump` 零命中）。

> 结论：造新 skill 前**必须先盘存量**，很多"想要的"已经存在。

### 2.6 Action 与 PatternCard 是两套机制

| | **Action（工具）** | **PatternCard（模式卡）** |
|---|---|---|
| 形态 | TypeScript 函数 | 示例代码 + whenToUse + pitfalls |
| 位置 | `cognitive/action/llm-actions.ts` | `cognitive/conscious/patterns/catalog.ts` |
| 成本 | **常驻 system prompt，58 tokens/个/轮** | 按需检索注入，**不常驻** |
| 适合 | 确定性流程（杀动物、造镐） | 情境判断（"torch 可能是 wall_torch"） |

`PATTERN_CATALOG` 目前是**硬编码静态数组**，`createPatternRuntime`（`patterns/runtime.ts:66`）只有 `get/find/ids/list`，**没有任何写入/持久化路径**。

### 2.7 CPU / 磁盘

- `entityMoved`：32 格内**每个实体**（含所有怪物）每次移动都产生 raw 事件，走 `nanoid×2 + deepFreeze + AsyncLocalStorage.run + 规则遍历`。而唯一消费它的规则要求 `entityType: player`（`rules/attention/movement.yaml`）→ **怪物那部分 100% 空转**。定义在 `events/definitions/entity-moved.ts:20`。
  - 对照：`physicsTick`(20Hz) 的 fall-tracker、`entityUpdate` 的 sneak-toggle 都在 filter 里就掐掉了，写法可参考。
  - 可能与 `main.ts:81` 那条"事件循环偶尔静默 ~30s"的 NOTICE 有关（**未证实**）。
- Debug 日志**没开也在写**：`DebugService.getInstance()` 一构造就 `initLogFile()` 开 `logs/session-*.jsonl` 写入流（`debug/server.ts:72,75`）；`broadcast()` 不管有无客户端都 `addToHistory`（内存留 1000 条）+ `persistEvent` 落盘。而 `traceLLM` 每轮把**整个 messages 数组**传进去。`ENABLE_DEBUG_SERVER=false` 拦不住。

## 3. 决策

### 已定

**D1 — 后端：走 `claude-code-brain`**（`http://localhost:14515/v1/`），模型用 **AIRI 聊天里选中的那个**，当前是 `claude-sonnet-4-6`。

> 该 ID 已被 brain 验证可用 —— 见 `claude-code-brain/src/index.ts:160` 的注释："explicit pinned IDs like claude-sonnet-4-6 also work (verified: the result's modelUsage bills under the explicit id)"。brain 会把订阅 picker 的实时别名和静态列表合并后一起提供。

⚠️ **实现注意**：MC 是**独立进程、独立 env**，它不读 AIRI 的设置，所以"跟随聊天选中"**不会自动同步**。目前只能手动对齐 `services/minecraft/.env.local`：

```bash
OPENAI_API_BASEURL='http://localhost:14515/v1/'
OPENAI_API_KEY='unused'            # brain 完全忽略这个值，填任意非空字符串
OPENAI_MODEL='claude-sonnet-4-6'   # 或 'default' = 跟随 Claude Code 默认模型
OPENAI_REASONING_MODEL='claude-sonnet-4-6'   # 目前无人使用，填同一个即可
```

若希望真正跟随，需新增同步机制：`module:configure` 事件目前只携带 `enabled/host/port/username`（`composables/runtime-config.ts` 的 `editableConfigSchema`），得扩字段。**本轮不做**，先手填。

**D2 — 接受 bot 消耗 Claude 订阅额度。** 这使 P0-2（噪音节流）和 P0-3（保缓存）的优先级更高：额度是共享的，bot 空转直接吃掉写代码的配额。

### 待定

| # | 决策 | 影响 |
|---|---|---|
| D3 | 噪音节流后 bot 的性格变化是否接受（如受伤不再每次都吭声） | P0-2 的验收标准 |
| D4 | PatternCard 自举（运行时保存成功代码）要不要做 | P2 范围 |
| D5 | P0-4 启动摘要的**输入源**：仅人设卡？还是也含上次会话的关键事实？ | P0-4 的实现范围 |

**未采纳的方案（附理由，避免重复讨论）：**
- ❌ **每轮压缩历史再喂大脑**：压缩会改写 user 序列 → 每轮打断 session → 比不压缩更贵
  - ⚠️ 注意与 **P0-4 区分**：P0-4 的摘要**只在启动时生成一次**然后固定，属于稳定前缀的一部分，不存在这个问题
- ⏸️ **中继模型分诊**：两半问题各有更便宜的解法（任务侧堆 skill、噪音侧规则节流），中继仅剩"聊天要不要惊动大脑"这类语义分诊有价值，**推迟到 P0/P1 效果实测后再评估**
- ⚠️ 若将来做中继：**两层模型不能共用 `conversationHistory`** —— 中继每追加一条 user 消息就会让 Claude 的 session lookup key 失配、打断缓存。中继必须用独立上下文，只有升级简报进 Claude 历史

## 4. 工作项

### P0-1 接线：暴露已有 skill 【最高性价比】

**问题**：79 个内部能力只暴露 25 个，模型被迫用原语手工拼装高层任务，且反复踩空指针。

**改动**：
1. 先解决 2.4 的**重复实现**（`placeBlock` / `tillAndSow` 二选一，删另一份并改调用点）
2. 给待暴露的 skill 补**结构化失败返回** —— 返回 `{ ok: false, reason: "缺 3 个圆石", missing: [...] }` 而非 `false`。**这条是前置条件**：失败粒度变粗会反过来烧轮
3. 在 `cognitive/action/llm-actions.ts` 逐个加 action 定义（zod schema + description）
4. 每个新 action 配测试（参考 `skills/combat.test.ts` / `crafting.test.ts` / `movement.test.ts`）

**建议顺序**（按收益）：
1. `goToNearestEntity` / `goToNearestBlock` ← 单独就能消掉 `augmentDecisionError` 那类崩溃轮
2. `ensure*` 14 个
3. `gatherWood` / `tillAndSow` / `placeBlock`(指定坐标)
4. `useDoor` / `moveAway` / `organizeInventory` / `pickupNearbyItems` / `stay`

**验收**：
- 工具数 25 → ~46；system prompt 增量用附录 A 的脚本实测（预估 +4,850 字符 ≈ +1,215 tokens/轮）
- 新增 action 全部有测试且通过
- `pnpm -F @proj-airi/minecraft-bot typecheck` 与 `pnpm lint` 绿

**风险**：工具从 25 增至 ~46 可能造成模型选择困难（选错工具也烧轮）。需同步更新 `brain-prompt.md` 的用法约定章节，说明高层 skill 优先于原语拼装。

### P0-2 噪音节流【纯规则，零模型调用】

**问题**：每条系统消息、每次掉血各触发一轮完整 LLM 调用。

**改动**：
1. `rules/danger/damage.yaml` → 改边沿锁存，**范本见 `events/definitions/low-health.ts:13` 的 `armed` latch 写法**（同一血量段内只触发一次，恢复后重新武装）
2. `rules/system-message.yaml` → 加冷却窗口或白名单（例如只放行包含 bot 名的消息）
3. `events/definitions/entity-moved.ts:20` filter 内加 `entity.type === 'player'`（一行，怪物移动不再进事件总线）

**验收**：
- 站在火里/岩浆里时唤醒次数从"每秒 1~2 次"降到"每次进入危险状态 1 次"（需实跑观测）
- 服务器广播刷屏时不再逐条唤醒
- 现有 `rules.test.ts`（692 行）全绿，并为新的锁存行为补测试

**风险**：D3 —— bot 会变得"钝"一些。受伤不再每次吭声。需要用户确认可接受。

### P0-3 保住 prompt 缓存【D1 已定 → 必修】

**问题**：见 2.2，历史裁剪会永久打断 session 缓存。

> **与 P0-4 配套**：本项让裁剪更激进（批量砍），而砍掉的最老消息正是人设所在 —— 所以 **P0-3 和 P0-4 必须一起做**，只做 P0-3 会掉人设，只做 P0-4 省不到钱。

**改动**：
1. `brain.ts:2070-2073` 裁剪改**批量**：到上限后一次砍 40 条（而非每轮 2 条），让 user 序列前缀在约 20 轮内保持稳定
2. 历史中**不存 / 不回传 `reasoning`**（`brain.ts:2062-2066`）—— DeepSeek 官方明确要求不要回传 `reasoning_content`
3. ~~在 `llm-agent.ts` 加 `cache_control` 断点~~ —— **D1 定为走 claude-code-brain 后本条不需要做**：缓存由 brain 的 SDK session 负责，MC 侧只要不破坏 user 序列前缀即可

**验收**：
- 走 claude-code-brain 时，观察其 stdout 的 `token estimate` 行 `mode=resume` 占比应显著上升（诊断方法见 `claude-code-brain/README.md`）
- 单测覆盖"历史超限后 user 序列前缀在 N 轮内不变"

**风险**：批量裁剪会让历史长度在 160~200 之间波动，属预期。

### P0-4 启动摘要：用 deepseek 生成极简常驻上下文【人设保鲜】

**问题**：P0-3 的历史裁剪砍的是**最老的**消息 —— 而最老的消息恰恰是人设、主人身份、长期目标建立的地方。裁得越狠，人设丢得越快。这是 P0-3 的副作用，必须配套解决。

**思路**：**每次进程启动时**用 deepseek（便宜、不占 Claude 额度）生成一份极简摘要，作为**稳定前缀的一部分**常驻。之后历史可以放心裁剪，人设不随之丢失。

**为什么这不违反"别压缩历史"的原则**（重要，别混淆）：
- 被否掉的是**每轮**压缩 —— 那会每轮改写 user 序列、每轮打断 session
- 本项只在**启动时生成一次然后固定**。启动时 `conversationHistory` 本来就是空的、session registry 里也没有条目，本来就是 fresh 起点。摘要一旦固定，它就是稳定前缀，之后每轮走 cache-read

**改动**：
1. 启动阶段调 deepseek 生成摘要，**长度硬上限**（建议 ≤ 800 字符）
2. 追加进 system prompt —— 做法参照现有的 `masterIdentitySection`（`prompts/brain-prompt.ts:174-175`，已经是"模板 + 动态追加"的形状）
3. 摘要**生成后即冻结**，运行期间绝不重算

⚠️ **安全约束（必须遵守）**：`masterIdentitySection` 里"绝不攻击主人""只听主人指令""不要把别的玩家当主人"那几条是**安全规则，必须逐字保留，不允许进摘要被改写**。摘要只用于补充人设语气/长期目标一类的软性内容。

⚠️ **缓存约束**：system prompt 变了会让 SDK 侧的缓存前缀失效。所以摘要必须每次启动固定一次，**不能运行中动态更新** —— 否则每次更新都是一次全量 cache-create。

**待定（D5）—— 摘要的输入源**，建议：
- 必含：人设卡 / 角色设定（语气、自称、对主人的称呼）
- 建议含：上次会话的关键事实（主人是谁、上次在做什么、家/基地坐标）
- 不含：具体对话流水（那是历史的职责，不该塞进常驻前缀）

**验收**：
- 摘要长度 ≤ 上限，且启动后不再变化（加断言/测试）
- 连续跑满并触发历史裁剪后（≥50 轮），人设关键项（自称、对主人的称呼、语气）仍稳定
- 安全规则段落逐字未被改写（可加单测：生成的 system prompt 必须包含若干固定关键句）

**风险**：deepseek 摘要质量不稳定，可能丢关键项或产生幻觉设定。缓解 —— 摘要只做"软性人设"，硬约束全部硬编码；并把生成结果打日志便于事后检查。

### P1-1 关掉默认的 debug 落盘

**改动**：`debug/server.ts:72` 的 `initLogFile()` 与 `broadcast()` 中的 `addToHistory`/`persistEvent` 按 `config.debug.server` 门控。

**验收**：`ENABLE_DEBUG_SERVER=false` 时不产生 `logs/session-*.jsonl`，内存中不驻留 1000 条事件。

### P1-2 no-action 追问预算

**改动**：`brain.ts:232` `NO_ACTION_FOLLOWUP_BUDGET_DEFAULT` 3 → 1 或 2。

**验收**：模型卡住时的连锁轮数下降；需确认不会让 bot 过早放弃任务。

### P1-3 暴击（唯一真缺的 combat 能力）

**改动**：在 `attackEntity`（`skills/combat.ts:140`）中加入跳跃暴击时序 —— 落地瞬间攻击。需与 mineflayer-pvp 的 `TimingSolver` 配合，不要打乱其 cooldown 节奏。

**验收**：击杀同类生物的平均耗时下降；不引入卡顿或寻路失败。

**风险**：可能与 pvp 插件的移动控制冲突。属可选项，收益是游戏性而非 token。

### P2 用 deepseek 批量造新 skill

**前置**：P0-1 完成并实机验证（先确认"接线"本身带来多少收益，再决定造多少新的）。

**真正的能力空白**（内部也没有）：钓鱼、村民交易、驯服/繁殖、骑乘、建造结构（搭桥/塔升/挖梯下降）、探索未知区域。

**两条路线**：
- **(a) 离线生成 Action**【推荐】：deepseek 产出 TS 函数 → 人工 review → 进 git → 带类型与测试。skill 是**确定性代码**，有 bug 会每次调用都错（不像 LLM 每轮重新想），这个安全边际值得慢
- **(b) 在线自举 PatternCard**：运行时把成功的 JS 存成 PatternCard 持久化（Voyager 那套）。需新建写入路径（见 2.6）。风险：存下来的是"碰巧成功过一次"的代码，会把偶然固化成惯例 → **必须有人工晋升机制**，不能自动进目录

**形态选择原则**：确定性流程 → Action；情境判断 → PatternCard。别把情境判断做成常驻工具（每轮 58 tokens）。

### P2-2 模板正文瘦身（收益待定）

`## Input + Runtime Log Objects`(10,870) + `## Query DSL`(4,962) = 模板的 40%，存在意义是教模型即兴写 JS 查世界、拼原语。**P0-1 之后即兴需求下降，这两节有瘦身空间** —— 但若缓存生效（P0-3），system prompt 走 cache-read 0.1x，收益会小很多。**建议 P0 全部完成、实测轮数分布后再评估。**

## 5. 非目标

- 不为本服务新建大型子系统（见弃用声明）
- **不做「每轮」历史摘要/压缩**（会打断 session 缓存）—— 注意 P0-4 的启动摘要是一次性的，不在此列
- 本轮不做"MC 自动跟随 AIRI 选中模型"的同步机制（见 D1，先手填 env）
- 本轮不实现中继模型（见"未采纳方案"）
- 不改动 Reflex 层的四个既有行为（auto-eat / defend / escape-hazard / idle-gaze）—— 它们是 0-token 路径，工作正常

## 附录 A：复现测量数字

```bash
cd services/minecraft
cat > measure.tmp.ts <<'EOF'
import { actionsList } from './src/cognitive/action/llm-actions'
import { generateBrainSystemPrompt } from './src/cognitive/conscious/prompts/brain-prompt'

const full = generateBrainSystemPrompt(actionsList, {}).length
const empty = generateBrainSystemPrompt([], {}).length
console.log('工具数:', actionsList.length)
console.log('完整 system:', full, '字符')
console.log('模板本体:', empty, '字符')
console.log('工具区块:', full - empty, '字符')
console.log('每工具均值:', Math.round((full - empty) / actionsList.length), '字符')
EOF
pnpm exec tsx measure.tmp.ts && rm measure.tmp.ts
```

模板分节体积：
```bash
awk '/^#{1,3} /{if(h)printf "%6d chars  %s\n", c, h; h=$0; c=0} {c+=length($0)+1} \
  END{printf "%6d chars  %s\n", c, h}' src/cognitive/conscious/prompts/brain-prompt.md
```

内部能力 vs 已暴露：
```bash
cd src
grep -hoP "^export (async )?function \K\w+" skills/*.ts skills/actions/*.ts | sort -u   # 79
grep -oP "name: '\K[^']+" cognitive/action/llm-actions.ts | sort                        # 25
```

## 附录 B：常用命令

```bash
pnpm -F @proj-airi/minecraft-bot typecheck
pnpm -F @proj-airi/minecraft-bot exec vitest run
pnpm exec vitest run services/minecraft/src/skills/combat.test.ts
pnpm lint && pnpm lint:fix
pnpm -F @proj-airi/minecraft-bot dev     # 需先配置 .env.local
```

> 注意：`pnpm dev` / `dev:tamagotchi` **不会**拉起本服务，必须单独启动。

## 附录 C：实施记录（2026-07-26）

P0 全部完成。P1/P2 未做。

### 决策落地

- **D3**：改成「围攻才吭声」。升级到意识层的四个门 —— 12 格内敌对生物 ≥3、攻击者是玩家、单次伤害 ≥6、陷在岩浆/火/水；外加边沿锁存（10s 无伤害才重新武装）。单个僵尸、普通摔伤一律静默，交给 defend/escape-hazard reflex（0 token）。
- **D5**：跨会话事实。新增 `cognitive/conscious/session-memory.ts`，退出时与每 20 轮把对话尾部（40 条）落盘到 `data/session-memory.json`，下次启动用独立的便宜模型摘成 ≤800 字符常驻前缀。
- **重复实现**：保留 `skills/blocks.ts`（功能更全：cheats /setblock 路径、torch/stairs/ladder/button 的 blockState 朝向处理、redstone_wire 名称映射），删掉 `skills/actions/world-interactions.ts` 里的 `placeBlock`/`breakBlockAt`/`activateNearestBlock`/`tillAndSow`，只留 `pickupNearbyItems`。同时把 world-interactions 版的两个优点并了过来：破坏后校验+重试一次、种子模糊匹配。

### 关键实现决定：结构化失败走返回值，不走抛错

`cognitive/conscious/js-planner.ts:1455` 捕获工具异常后只保留 `errorMessageFrom(error)` 一个字符串 —— **`ActionError` 的 `code` 和 `context` 到不了模型**。所以 spec §4 P0-1 说的「结构化失败返回」实现为返回 `SkillResult = { ok, reason, message, missing?, detail? }`（`skills/base.ts`），只有中断/参数非法才继续抛。仍在抛 `ActionError` 的 `ensure*` 家族没有改内部实现，而是在 `llm-actions.ts` 的 `structured()` 包装器里把 code/context 翻译成 `SkillResult` —— 这样 ensure* 之间的互相调用不受影响，改动面收在 LLM 边界一层。

### 实测数字（附录 A 的脚本）

| | 改前 | 改后 |
|---|---|---|
| 工具数 | 25 | **49** |
| system prompt | 37,721 字符 | **46,657** |
| 模板本体 | 31,937 | 34,151（+2,214：新增「Choosing a tool」「Reading tool results」两节） |
| 工具区块 | 5,784 | 12,506 |
| 内部 skill 总数 | 79 | 81（新增 helper） |

每轮 +8,936 字符 ≈ +2,234 tokens。缓存生效时走 cache-read（0.1x），且换掉的是模型自己拼装原语的那些轮 —— 净收益要实跑才能确认。若实测发现工具太多导致选择困难，优先砍 `ensureCampfire` / `ensureShovel` 这类低频项。

### 新增/修改文件

- 新增：`cognitive/conscious/session-memory.ts`、四个测试文件（damage-taken / system-message / entity-moved / conversation-trim / session-memory）
- `brain.ts`：裁剪改批量 40 条并抽成可测的 `trimConversationHistory`；不再存 `reasoning`；启动摘要加载与会话记忆落盘
- `skills/base.ts`：新增 `SkillResult` / `skillOk` / `skillFail`

顺手修掉的既有 bug（都在改动路径上）：
- `blocks.ts` 的 `findNearestDoor` 把 `bot` 当 `Mineflayer` 传给 `getNearestBlock`，`useDoor` 从来找不到门
- `collect-block.ts` 的 `collected++` 无条件自增，挖失败也计数，导致上报的资源量虚高
- `movement.ts` 的 `moveAway` 采样循环无出口，站在水里会挂死整轮
- `stay(-1)` 表示「永远」，作为 LLM 可调工具意味着一个坏参数就卡死到进程重启（现已 clamp 到 300s 并可被 interrupt 打断）

### 验证

- `pnpm lint` 绿
- `tsc --noEmit`：剩余报错只在未改动的文件（`patched-goto.ts` / `world.ts` / `map-renderer.ts` / `mcdata.ts` / `gaze.ts` / `reflex/runtime.ts`），全是既有的 vec3 0.1.10 与 0.2.0 双版本冲突
- vitest：改动涉及的 17 个文件 128 passed / 1 failed，唯一失败是 `rules.test.ts` 的 out-of-order timestamps（**改动前后完全相同**，未碰规则引擎）
- `brain.test.ts` / `js-planner.test.ts` / `map-renderer.test.ts` 在本机沙箱里 44 failed —— 已用 `git stash` 对比确认基线一模一样，原因是 Node permission model 拦住了 js-planner 的子进程（`Access to this API has been restricted`），不是本次改动引入

### 还需人工做的事

1. 按 D1 手填 `.env.local` 的 `OPENAI_*` 指向 claude-code-brain
2. 想启用启动摘要，再填 `SUMMARY_API_BASEURL` / `SUMMARY_MODEL`（`.env` 里有注释模板）。不填则该功能静默关闭，其余一切照常
3. 实跑采数据，再决定 P1-2（no-action 预算 3→1/2）和 P2-2（模板瘦身）
