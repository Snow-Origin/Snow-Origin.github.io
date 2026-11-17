# Snow Origin 对外网页

雪梦未来（Snow Origin）统一的对外研究网页仓库，GitHub 仓库 `Snow-Origin/Snow-Origin.github.io`，经 GitHub Pages 发布于 https://snow-origin.github.io/ 。

## 公开边界

仓库与全部提交历史公开。只放已确认对外的静态页面与压缩素材；代码、原始数据、内部文档、未确认对外的数字一律不进仓库，误提交删除后仍留在历史中。

## 目录

| 路径 | 内容 |
| --- | --- |
| `index.html` | 研究主页：项目列表、官网与公众号 |
| `assets/brand/` | 品牌资源：横版 logo、圆形 logo、公众号二维码 |
| `assets/css/site.css` | 全站基础样式与颜色变量 |
| `<项目>/index.html` | 项目页，URL 为 `/<项目>/`，目录名用英文小写连字符 |
| `<项目>/static/` | 该项目素材：`videos/`、`images/`、`data/`；项目页只引用本目录与 `assets/` |

`assets/` 只放品牌资源和至少两个项目共用的代码；项目专用脚本留在项目目录，第二个项目需要时再上移。页面为手写静态 HTML／CSS／JS，不引入构建步骤。

## 素材

- 单文件 ≤50 MB（GitHub 硬上限 100 MB），全仓库 ≤1 GB；超出的视频传视频平台后嵌入。
- 视频用 H.264 MP4，首屏视频静音自动播放并设 `playsinline`。
- 素材由各项目私有仓库生成，生成代码不进本仓库。来源仓库根目录用相对软链接 `site -> ../SnowOriginPages/<项目>` 直接写入对应项目目录，本仓库须克隆在与来源仓库同级的 `SnowOriginPages/`。

## 预览与发布

本地预览：在仓库根目录运行 `python3 -m http.server 8000`，打开 http://localhost:8000/ 。推送 `main` 后由 GitHub Pages 自动发布。

## 项目

| 项目页 | 状态 | 来源仓库（私有） |
| --- | --- | --- |
| `egotact/` | 待发布：等算法方案定稿 | `Snow-Origin/EgoEmg2Force` |
