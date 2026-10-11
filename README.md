# ComfyUI-MobileUI

在局域网内用手机、平板或电脑快速运行 ComfyUI 工作流的简化网页。直接使用主界面里保存的工作流，不需要编辑节点图，只修改提示词和参数，点「生成」即可出图。

## 功能

- 直接读取主界面保存的工作流（`user/default/workflows/`），按子文件夹分类，可以搜索
- 支持子图、绕过/静音节点、Reroute、PrimitiveNode，转换规则与主界面一致
- 正向 / 负向提示词顺着连线自动识别
- 常用参数置顶：种子、步数、CFG、采样器、调度器、降噪、宽高、批次、模型；其余参数收在可筛选的「其他参数」折叠区
- 种子 🎲 随机按钮和「每次生成随机」选项
- 文件名前缀支持 `%date:yyyy-MM-dd%`、`%节点标题.参数%`
- 进度条、采样实时预览、点击放大查看结果图
- 生成中可以中断或取消排队
- 在浏览器中按工作流记住上次填写的值
- 响应式布局：手机单栏，宽屏时参数面板和结果左右分栏；跟随系统的深色 / 浅色主题
- 纯原生 HTML/CSS/JS，没有额外依赖，不访问外网

## 安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/chen079/ComfyUI-MobileUI.git
```

重启 ComfyUI。

## 使用

1. 在主界面中把工作流保存好（**工作流 → 保存**）。子文件夹会作为分类显示。
2. 用局域网监听模式启动 ComfyUI：
   ```bash
   python main.py --listen
   ```
3. 在同一网络的设备上打开 `http://<电脑IP>:8188/webui`。

> 手机打不开时，请检查 Windows 防火墙是否放行了 8188 端口。

工作流需要包含 `SaveImage` 或 `PreviewImage` 节点，否则不会有图片输出。工作流用到的插件节点或模型如果本机没有，提交时会显示 ComfyUI 的校验错误。

## 接口

| 路径 | 说明 |
|---|---|
| `GET /webui` | 网页 |
| `GET /webui/api/workflows` | 列出已保存的工作流（路径、名称、分类） |
| `GET /webui/api/workflow?path=…` | 转换后的 API prompt 和可编辑参数列表 |

生成、进度、取图直接使用 ComfyUI 自带的 `/api/prompt`、`/ws`、`/api/history`、`/api/view`。

## 注意

`--listen` 会让局域网内的所有设备都能访问 ComfyUI，请只在可信网络中使用。

## 许可证

[MIT](LICENSE)
