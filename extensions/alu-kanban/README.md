# Alu Kanban Pi Extension

本目录是 Alu Kanban Pi 扩展的**开发源代码和单一维护入口**。

- Development 扩展：项目内 `alu-kanban-dev`
- Production 发布目录：`~/.pi/agent/extensions/alu-kanban/`
- 按需操作指南：`skills/alu-kanban/SKILL.md`
- 后端/API/实时同步图谱：`docs/agent_maps/kanban.md`

不要直接修改全局 production 副本；所有功能变更先在这里开发、测试，再同步发布。扩展只常驻精简的能力、Skill 触发和不可信卡片数据提示；完整操作工作流通过 `resources_discover` 提供的 `alu-kanban` Skill 按需加载。Development 与 Production 同时存在时由 Development 源码提供该 Skill，避免同名资源冲突；其他项目由 Production 扩展提供。

## 1. 运行环境

### Development

- Tool：`alu_kanban_dev`
- Command：`/alu-kanban-dev enable|disable|status|help`
- API：`http://192.168.1.195:15501/api`
- 默认 inactive，每次 session/reload 后需要显式 enable
- Token 首先读取进程环境变量；缺失时允许读取当前项目被 `.gitignore` 排除的 `.env`

```text
ALU_KANBAN_DEV_ASSISTANT_KEY
ALU_KANBAN_DEV_ENGINEER_KEY
```

### Production

- Tool：`alu_kanban`
- Command：`/alu-kanban enable|disable|status|help`
- API：`https://home.aruru.moe/api`
- 默认 active
- 非空进程环境变量优先；缺失时由扩展直接读取 `~/.config/alu-kanban/env`
- 每次 status/tool 调用重新解析私有文件，不缓存；始终禁止读取项目 `.env`

```text
ALU_KANBAN_ASSISTANT_KEY
ALU_KANBAN_ENGINEER_KEY
```

## 2. Production 凭据配置

当前用户 shell 为 zsh。建议把密钥放入独立的权限文件，而不是项目仓库：

```bash
mkdir -p ~/.config/alu-kanban
chmod 700 ~/.config/alu-kanban
$EDITOR ~/.config/alu-kanban/env
chmod 600 ~/.config/alu-kanban/env
```

文件内容只允许空行、`#` 注释和以下两个 literal export；额外变量、重复变量、shell 展开、命令替换或其他命令会使整份文件 fail closed：

```bash
export ALU_KANBAN_ASSISTANT_KEY='assistant-api-key'
export ALU_KANBAN_ENGINEER_KEY='engineer-api-key'
```

Production 每次 `/alu-kanban status` 和每次工具调用都会重新读取该文件，因此修改 Key 后的下一次调用立即生效，不需要 `/reload` 或重启 Host。扩展要求当前用户拥有目录和文件，目录必须是非 symlink 的 `0700` directory，文件必须是非 symlink 的 `0600` regular file。状态与错误只报告 `configured`、`missing` 或 `invalid`，不输出 token、文件内容或非法行。

交互式 shell 如需复用同一份配置，可以在 `~/.zshrc` 中加入：

```bash
source ~/.config/alu-kanban/env
```

然后重新打开终端并启动 Pi，或在启动 Pi 前执行：

```bash
source ~/.config/alu-kanban/env
```

由 systemd、桌面进程或其他非交互式入口启动的 Pi 不需要 source `.zshrc`，也不需要为 Alu Kanban 增加 service-specific environment 注入；凭据解析由扩展统一负责。非空进程环境仍保持最高优先级，便于显式临时覆盖。

## 3. API 账号准备

Production 使用两个独立的 `User#api_key`：

- assistant：助手账号
- engineer：工程账号

通过 Rails console 为用户生成或读取 key：

```ruby
user = User.find_by!(email: 'account@example.com')
user.generate_api_key! if user.api_key.blank?
user.api_key
```

两个账号必须对目标 Board 具备对应的 owner/member/admin 权限。Assistant 和 engineer 新建卡片时默认把负责人设为 `/api/me` 返回的自己，因此对应账号必须是该 Board 的 participant。

不要把 production key 写入：

- `.pi/alu-kanban.json`
- 项目 `.env`
- Git 仓库
- 卡片描述

## 4. 角色选择

默认角色是 `engineer`。

可信项目可以通过项目配置覆盖：

```text
.pi/alu-kanban.json
```

Assistant production 工作流配置：

```json
{
  "role": "assistant",
  "defaults": {
    "board_id": 1,
    "workflow": {
      "backlog": { "list_name": "backlog" },
      "todo": { "list_name": "todo" },
      "doing": { "list_name": "doing" },
      "done": { "list_name": "done" }
    },
    "create_stage": "backlog"
  },
  "guardrails": {
    "allowed_board_ids": [1]
  }
}
```

`board_id` 是项目默认值；workflow 保存逻辑阶段对应的 **List 名称**，不保存 List ID。扩展每次从 Lists API 解析唯一的 active List，因此归档旧 `done` 并创建新 `done` 后无需更新 ID。`allowed_board_ids` 是 Assistant 的硬边界且必须至少配置一个；缺失或空数组会 fail closed。Assistant 的 `list_cards` / `my_tasks` 没有默认 Board 时，单个 allowed Board 会自动收敛，多 Board 则要求显式选择其中一个，禁止跨边界读取。

列表选择参数 `list_id`、`list_name`、`workflow_stage` 互斥。`list_name` 支持任意自定义名称。`workflow_stage` **不是内建枚举**，只接受当前可信项目配置中实际存在的映射；无映射时必须传 `board_id + list_name/list_id`。缺少默认 Board、create stage 或目标 stage 时，workflow preflight 会在调用 API 前一次性报告当前 defaults/stages、正确替代 selector 和当前 profile 的 status 命令。

项目配置只表达角色、Board 和 workflow 语义，不含 URL、环境或凭据。Development/Production 继续由 profile 隔离，并可安全共享同一份项目 workflow；只有两套环境的 Board/List 语义真正不同时才需要另行设计 profile override。

项目配置示例位置：

```text
~/workshop/alubot_admin/.pi/alu-kanban.json    # engineer，Board 1，四阶段映射
~/workshop/alu_workstation/.pi/alu-kanban.json # assistant
```

项目未受 Pi 信任、配置不存在、JSON 无效或 role 不是 `assistant` 时，均 fail closed 为 `engineer`；可信 engineer 配置仍可提供非秘密的 Board/workflow defaults。`/alu-kanban status` 会显示默认 Board、可用 stage、create stage、推荐 selector，并验证 workflow 的 active List 解析结果；`/alu-kanban help` 展示当前角色可用 action、当前 selector 可用性和操作规则。

角色 action allowlist 的唯一实现位于 `permissions.ts`：

- engineer：读取、单卡/有序批量建卡、编辑（含 description 唯一片段精确替换）、移动、completion、Checklist 批量写入/重排、Board 标签原子增删、卡片评论、附件；不能 delete card
- assistant：在 engineer 基础上增加 delete card
- engineer 建卡沿用配置的 Backlog 默认阶段与自动指派；描述必须交代发现背景和单独排期理由，进入 Backlog 不代表获准开工
- delete card/attachment 以及嵌套 Checklist `_destroy: true` 要求交互式确认

所有 Rails API 请求必须使用具体 User 的 `api_key`；旧全局 LEGACY token 已移除，不再存在无身份的全量 Board scope。

Agent 建卡：

- `create_card` 创建单卡；`create_cards` 在同一 active List 中一次创建 1–50 张卡；
- `create_cards.cards` 数组顺序就是持久化相对顺序，整个批次原子提交并返回最终连续 position；
- 有顺序或无顺序的一组任务都应优先使用一次 `create_cards`，不要并发发送多个 `create_card`。

Board 标签与卡片评论：

- `list_labels` 返回规范名称、固定颜色和 usage_count；`add_card_label` / `remove_card_label` 不整组覆盖；
- 默认目录包含常见工作类型与 P0/P1/P2，自定义标签仍可按需创建；
- `list_comments` 使用有界 keyset 分页，`create_comment` 只追加内容，不改写 description；
- `create_comment` 不是常规生命周期动作：开工、AI 自定义里程碑、实现切片、commit、测试、Review、部署、子任务和日常状态均不评论；
- 仅用户明确要求，或用户验收当前阶段并定义下一阶段、作出正式范围/方向决定、确认最终验收/关闭时，合并追加一条简洁评论；Checklist、卡片字段、子卡或验证文档已有的事实不重复评论；
- 评论第一阶段 append-only，不提供编辑/删除。

AI Checklist 写入不复用 Web 的逐项 action：

- `create_card` / `update_card` 的 `checklist_items` 数组批量创建、更新 content/completed 或通过 `_destroy` 显式删除；
- `reorder_checklist` 必须提交当前卡片全部 Checklist ID 的完整目标顺序 `item_ids`；
- 旧的逐项 create/update/completion/delete/sort Checklist action 已移除；
- API 返回 canonical Checklist，扩展回执验证嵌套操作和最终顺序。

角色限制是内部操作护栏，不是服务端 token scope；真正的数据可见/管理范围仍由 Rails API key 对应 User 决定。

### 输出策略

- Assistant 的 `my_tasks` / `list_cards` 默认 compact；`get_card` compact 仍保留 description。
- Engineer 读操作默认保留原始详细响应，避免既有工作流回归。
- 两种角色都可显式传 `detailed: true|false`。
- Card create/batch create/update/description edit/move/completion 默认返回 mutation receipt：逐字段比较请求与持久化响应，输出 `verified` / `mismatches`；长 description 只返回验证结果和长度。
- `edit_card_description` 使用 `card_id`、`old_text`、`new_text` 精确替换唯一片段；原文不存在或不唯一时停止，写入前卡片发生变化时返回冲突。
- 标签未传 color 时按规范化名称验证并接受服务端 canonical 颜色；显式传 color 时继续验证名称和颜色。
- 嵌套 Checklist 写入和 `reorder_checklist` 回执包含最终连续顺序，并验证 create/update/completed/destroy/order 是否持久化。
- 标签增删回执验证 canonical 标签集合；评论回执验证正文但只输出长度、作者和时间，不重复长内容。
- 写操作传 `detailed: true` 时返回服务器原始响应。
- `move_card` 与 `set_card_completed` 始终独立，移动到 Done 不隐式完成卡片。

## 5. 代码结构

| 文件 | 职责 |
|---|---|
| `index.ts` | Development entry point |
| `extension.ts` | Pi tool/command、active tools、确认和渲染 |
| `profiles.ts` | Development/production 名称、URL、token env |
| `config.ts` | Role、项目 workflow/guardrail，以及 Development dotenv / Production 私有文件热读取与严格 token 校验 |
| `metadata.ts` | Action 列表与 help metadata 单一数据源 |
| `schemas.ts` | TypeBox 聚合 action schema |
| `skill.ts` | 精简常驻提示、Skill 路径与 Development 优先发现规则 |
| `skills/alu-kanban/SKILL.md` | 按需加载的完整 Kanban 操作工作流 |
| `permissions.ts` | Assistant/engineer allowlist |
| `client.ts` | fetch JSON/Multipart/download、超时、错误归一化 |
| `workflow.ts` | 默认 Board、active List、assignee 与 allowed Board 解析 |
| `actions.ts` | Action 到 Rails API 的映射 |
| `presenter.ts` | Assistant 精简读取与 mutation receipt |
| `help.ts` | Help/Status 文案（复用 action/config metadata） |
| `test/*.test.ts` | Extension 单元测试 |

卡片标题、描述、代码块、反引号和 `$()` 只能作为 JSON/FormData 数据传输。扩展代码不得通过 Bash、curl、Python CLI 或 `pi.exec` 操作 Kanban。

## 6. 开发流程

1. 在 `alubot_admin` 功能分支修改本目录和 Rails API。
2. 启动 development：

   ```bash
   bin/dev
   ```

   Rails 监听地址由 `Procfile.dev` 定义。同机使用 `127.0.0.1:15501`，局域网其他机器使用 `192.168.1.195:15501`。

3. 在 Pi 中启用开发工具：

   ```text
   /reload
   /alu-kanban-dev enable
   /alu-kanban-dev status
   /alu-kanban-dev help
   /skill:alu-kanban
   ```

   `/skill:alu-kanban` 用于显式检查按需指南；正常情况下，涉及 `card #编号`、看板任务推进、卡片状态同步或用户要求记录验收/决策/下一阶段检查点时由 Agent 根据 Skill description 加载。加载 Skill 或获准推进卡片本身不授权常规进度评论。

4. 只对 development 数据进行联调。
5. 运行 Rails、extension 和类型检查。
6. Reviewer 通过后提交。
7. 将同一套核心文件发布到 global production 目录。
8. `/reload` 或重启 Pi，再执行 `/alu-kanban status`。

## 7. 测试

```bash
RAILS_ENV=test bin/rails db:prepare
bundle exec rspec
node --test .pi/extensions/alu-kanban-dev/test/*.test.ts
```

TypeScript 类型检查需使用 Pi 当前安装版本的类型声明。Pi 运行时加载冒烟：

```bash
pi --list-models >/dev/null
```

自动测试不得访问 `home.aruru.moe`。

## 8. Production 发布

Pi Extension 发布独立于 Rails/Mina deploy：后者不会触碰仓库外的 global 目录。凡是共享核心文件发生变化，任务 Agent 在源码合并后必须执行本节同步，再通知用户 `/reload`；“不做 Production API 测试”不等于“跳过 Extension 文件发布”。只有用户明确要求暂缓发布或明确接管同步时才保留此步骤待办。

Global 目录是发布产物：

```text
~/.pi/agent/extensions/alu-kanban/
```

发布时同步以下共享核心文件：

```text
actions.ts
client.ts
config.ts
extension.ts
help.ts
metadata.ts
permissions.ts
presenter.ts
profiles.ts
schemas.ts
skill.ts
workflow.ts
README.md
skills/alu-kanban/SKILL.md
```

Production `index.ts` 必须保持：

```typescript
import { PRODUCTION_PROFILE } from "./profiles.ts";
import { createKanbanExtension } from "./extension.ts";

export default createKanbanExtension(PRODUCTION_PROFILE);
```

发布后核对全部共享文件，并单独确认 `index.ts` profile：

```bash
for file in actions.ts client.ts config.ts extension.ts help.ts metadata.ts permissions.ts presenter.ts profiles.ts schemas.ts skill.ts workflow.ts README.md; do
  diff -u ".pi/extensions/alu-kanban-dev/$file" "$HOME/.pi/agent/extensions/alu-kanban/$file"
done
diff -u ".pi/extensions/alu-kanban-dev/skills/alu-kanban/SKILL.md" "$HOME/.pi/agent/extensions/alu-kanban/skills/alu-kanban/SKILL.md"
grep -q 'PRODUCTION_PROFILE' "$HOME/.pi/agent/extensions/alu-kanban/index.ts"
pi --list-models >/dev/null
```

## 9. 参考文档

项目内：

- `docs/agent_maps/kanban.md` — Rails 模块、API、实时同步和测试入口
- `spec/requests/api/kanban/` — 可执行 API 契约
- `.pi/extensions/alu-kanban-dev/test/` — 可执行扩展契约

Pi 官方安装包内文档：

- `@earendil-works/pi-coding-agent/docs/extensions.md`
- `@earendil-works/pi-coding-agent/docs/packages.md`
- `@earendil-works/pi-coding-agent/examples/extensions/`
