---
name: gmi-music
description: 用户要求生成歌曲、配乐、音乐样例，或取回 GMI 已有音乐请求时使用。说明 music_gen 调用、配置和失败恢复。
---

# GMI 音乐生成

## 前置条件

- Pi 已加载 [music-gen 扩展](../../extensions/music-gen.ts)，提供 `music_gen` 工具。
- 跟用户确认后再执行付费生成；明确要求生成即为本次授权。仅配置或检查工具时，不提交生成请求。
- 凭据优先使用 Pi 进程中非空的 `GMI_API_KEY`（去除首尾空白）；否则读取 `~/.config/alu-musicgen/env`。用户自行将文件中的空值填为 `export GMI_API_KEY='密钥'`。不要在对话中索取、读取或输出密钥。
- Linux/macOS：配置目录必须由当前用户拥有、权限 `0700`；`env` 必须由当前用户拥有、权限 `0600`。Windows：检查目录和文件的 NTFS ACL，所有者与允许访问者仅限当前运行用户、SYSTEM、Administrators；继承的其他用户组允许权限也会被拒绝。Windows 使用系统自带 PowerShell 查询权限，不读取或执行文件内容，也不自动修改 ACL。
- 两端均拒绝符号链接和非普通文件。文件最多 16 KiB，只允许一条 `export GMI_API_KEY=字面值`、空行和注释；不执行 shell，不支持变量替换、命令替换或其他命令。推荐使用单引号。Windows 的默认位置是运行 Pi 账户 Home 下的 `.config\alu-musicgen\env`，仍按这个 export 文本格式以 UTF-8 保存。
- 修改扩展及 skill 后在 Pi 执行 `/reload`（项目需受信任）。文件密钥每次调用读取，单独修改文件不需要重载；更改启动环境中的变量后需重新启动 Pi。

## 使用

1. 新生成同时提供 `prompt` 和 `lyrics`。`prompt` 为风格、情绪、乐器等描述，可为空，最多 2000 字符；`lyrics` 必填，1–3500 字符，可含 `[Verse]`、`[Chorus]` 等结构标签。
2. 调用 `music_gen`，模型固定为 `minimax-music-3.0`，输出 MP3，44100 Hz、256000 bitrate。
3. 将返回的本地绝对路径和 request ID 提供给用户。文件位于**本次调用的工作目录**下 `test/gmi-music/music-<时间>-<唯一标识>.mp3`；不会覆盖既有音频。

示例（只有获得生成授权后执行）：

```json
{"prompt":"轻缓钢琴与弦乐，安静，无人声","lyrics":"[Inst]"}
```

`[Inst]` 和无人声描述只表达意图，不能保证纯器乐；接口没有独立 instrumental 参数。不要承诺指定时长或纯音乐效果。

## 超时与恢复

- 单次操作最多 240 秒，最多 40 次后续查询；音频下载上限 100 MiB。取消会停止本地等待，不代表服务端停止生成或撤销费用。
- 已拿到 request ID 时，仅取回已有请求：`music_gen({"request_id":"已有请求ID"})`，不再传 `prompt` 或 `lyrics`。该模式只查询、下载，不提交新生成。
- 提交超时且未拿到 ID 时，先请用户在 GMI 控制台检查请求；不能因为报错就自动重新生成，以免重复计费。
- 下载失败也使用原 ID 恢复。工具只接受公共 HTTPS 音频地址，不跟随重定向；地址过期或重定向需检查服务端结果。

## 迁移与复用

凭据路径固定为 `~/.config/alu-musicgen/env`，不取决于扩展位置或当前工作目录。旧 `.pi/music-gen.config.json` 已停用，不再读取；保留 git 忽略，不将其中的密钥复制到对话。

迁移到全局时，将扩展放到 `~/.pi/agent/extensions/music-gen.ts`，skill 放到 `~/.pi/agent/skills/gmi-music/SKILL.md`，无需迁移凭据文件，然后 `/reload`。避免同时加载项目和全局两份同名工具。输出仍跟随每次调用的 `ctx.cwd`。

离线检查：在项目或军火库根目录运行 `node --test test/gmi-music/music-gen.test.mjs`。测试优先读取仓库内 `extensions/music-gen.ts`，否则使用全局扩展。集成测试通过实际 Pi loader 加载工具；默认寻找 Home 下 `.local/share/alu-dock/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`，其他安装布局可用 `MUSIC_GEN_TEST_LOADER` 指定 loader 文件路径。

找不到 Pi loader 时，仅运行原生文件凭据测试、明确跳过集成项；此模式要求 Node 支持 TypeScript type stripping（必要时加 `--experimental-strip-types`），并能解析 `typebox`。测试只使用假密钥、临时配置和假网络，Windows ACL 也仅修改临时测试夹具，不提交付费请求。Windows 文件读取及宽权限拒绝已原生验证；Linux 完整离线工具流程已验证。真实服务响应、生成质量和账户权限仍需用户后续授权样例验证。
