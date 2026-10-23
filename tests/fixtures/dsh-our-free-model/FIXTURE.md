# 测试夹具：dsh-our-free-model

这是**真实**的 DSH 插件，不是仿制品。用来考我们的 cordis 迷你容器
在真实插件面前会不会塌。

## 来源

| 项 | 值 |
|---|---|
| 仓库 | `Ebony-Vinyl/dsh-our-free-model`（`zouyuxuan122/dsh-our-free-model` 会重定向到这里，是同一个仓库） |
| 版本 | `2.5.9` |
| 许可证 | MIT |
| 拉取方式 | jsDelivr 镜像（`cdn.jsdelivr.net/gh/Ebony-Vinyl/dsh-our-free-model@2.5.9`） |

## 为什么裁剪了内容

原包 4.1M，裁剪后 1.2M。去掉的是：

- `vendor/channel-pack/`（2.5M）—— 十个第三方账号渠道的打包产物。
  插件通过 `ctx.inject(['credentials', 'commands', 'llm'], ...)` 动态 import 它。
  手机上没有 `credentials` / `commands` 服务，按 cordis 语义这段回调
  **永远不会执行** —— 这正是我们要测的行为，所以不需要这个文件。
- `client.js`（496K）—— 浏览器侧的那半（六页毛玻璃界面），
  Node 侧根本不会加载。

保留的是插件的全部 Node 侧逻辑：`index.js` + `src/` + `adapter/`。

## 更新夹具

```bash
VER=2.5.9
B="https://cdn.jsdelivr.net/gh/Ebony-Vinyl/dsh-our-free-model@$VER"
D=tests/fixtures/dsh-our-free-model
rm -rf "$D" && mkdir -p "$D"
for f in index.js package.json cordis.patch.yml; do
  curl -sL "$B/$f" -o "$D/$f"
done
for d in src adapter; do
  mkdir -p "$D/$d"
  # 按包内文件清单逐个取
  ...
done
```

或者用 `scripts/fetch-fixture.sh`（如果存在）。

## Node 版本要求

插件 `engines` 要求 `^22.19.0 || >=24.0.0`，用到 `node:module` 的
`registerHooks`（Node 22.15+ 才有）。手机端的 libnode 是 **22.23.2**，
满足要求；但沙箱/CI 的 Node 若低于 22.19，这个夹具测试会**跳过**并说明原因。

```bash
node --version   # 需要 >= v22.19.0
```
