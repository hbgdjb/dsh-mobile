# 移植说明 / Port notes

本目录保存上游插件的原始产物，仅作溯源与 MIT 许可留存，**不会被打进 APK / PWA**。

- 上游：<https://github.com/Microqian2th/dsh-codex-effort-slider>
- 版本：1.1.2
- 许可：MIT（见 `LICENSE`）
- 上游产物：`lib/client.js`（React + DOM 桥）、`lib/index.js`（宿主锚点）、`cordis.patch.yml`

## 本应用里的实现

`scripts/effort-slider.js` 是按 `lib/client.js` 重写的原生 DOM 版本：

| 项 | 上游 | 本应用 |
| --- | --- | --- |
| 挂载位置 | DSH 官方模型菜单的「推理等级」行 | 「模型」面板的「推理等级」行 |
| 渲染 | React portal | 原生 DOM |
| 数据 | `directoryFor(sessionId)` 的 `reasoning.efforts` | `state.settings.reasoning`（Off / Low / High / Max） |
| 颜色 / 能量 / 星尘 | 位置驱动的纯函数 | 逐字移植（22 颗、黄金比相位、确定性伪随机） |
| 运动引擎 | 刹车预测 + 速度跟踪 | 逐字移植（完整 / 简洁 / 快速三组参数） |
| 设置 | 右键滑条 | 长按滑条（桌面端右键同样可用） |
| 设置键 | `dsh-codex-effort-slider.settings` | 同名键，可直接沿用 |

上游的宿主钩子、`ctx.slots`、`modelDirectories` 等 Cordis 接口没有移植——Android WebView 里没有 Node/Cordis 运行时。
界面与交互按上游 1:1 复刻，数据写入口换成应用自己的 `setSettings`。
