# ComfyUI-MobileUI

在局域网内用手机快捷运行 ComfyUI 工作流的简化网页。手机上不编辑节点图，只修改提示词和参数，点「生成」就能看到图片。

## 功能

- 多个预设工作流，下拉切换
- 正向 / 负向提示词（根据连线自动识别）
- 常用参数置顶：种子、步数、CFG、采样器、调度器、降噪、宽高、批次、模型
- 其余可调参数收在「其他参数」折叠区
- 种子 🎲 随机按钮和「每次生成随机」选项
- 进度条、采样实时预览、生成结果展示（点击查看原图）
- 生成中可以中断或取消排队
- 在手机浏览器中按工作流记住上次填写的值
- 纯原生 HTML/CSS/JS，没有额外依赖，不访问外网

## 安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/MIVIUS-s/ComfyUI-MobileUI.git
```

重启 ComfyUI。

## 使用

1. 在电脑上的 ComfyUI 中打开工作流，菜单 **工作流 → 导出 (API)**，把 JSON 保存到 `custom_nodes/ComfyUI-MobileUI/workflows/`。文件名就是手机上显示的名字；新增文件后刷新页面即可，无需重启。
2. 用局域网监听模式启动 ComfyUI：
   ```bash
   python main.py --listen
   ```
3. 手机连接同一 Wi-Fi，打开 `http://<电脑IP>:8188/mobileui`。

> 手机打不开时，请检查 Windows 防火墙是否放行了 8188 端口。

工作流必须包含 `SaveImage` 或 `PreviewImage` 节点，否则不会有图片输出。

## 接口

| 路径 | 说明 |
|---|---|
| `GET /mobileui` | 手机页面 |
| `GET /mobileui/api/workflows` | 列出 `workflows/` 中的工作流 |
| `GET /mobileui/api/workflows/{id}` | 工作流内容和可编辑参数列表 |

生成、进度、取图直接使用 ComfyUI 自带的 `/api/prompt`、`/ws`、`/api/history`、`/api/view`。

## 注意

`--listen` 会让局域网内的所有设备都能访问 ComfyUI，请只在可信网络中使用。

## 许可证

[MIT](LICENSE)
