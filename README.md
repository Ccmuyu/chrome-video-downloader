# chrome-video-downloader

Chrome 扩展（Manifest V3）。打开播放页后嗅探视频和音频，直链直接保存，HLS（m3u8）分片下载后在本地封装成 MP4。

产品行为对齐 [CocoCut](https://cococut.net/)：角标提示条数、弹层列出资源、可选清晰度、直播可录到手动停止。实现只走通用嗅探，不做单个网站的签名破解。

只保存你有权下载的内容。标准 HLS（明文，或播放列表里自带密钥地址的 AES-128）在本机解密和封装。Widevine、FairPlay、PlayReady 不在范围内。

完整设计见 [docs/方案.md](docs/方案.md)。当前实现见 [docs/技术文档.md](docs/技术文档.md)。

## 开发

```bash
pnpm install
pnpm test
pnpm build
```

构建结果在 `output/chrome-mv3`。Chrome 打开 `chrome://extensions`，打开开发者模式，选择「加载已解压的扩展程序」。

第一期包含：站点授权、按标签页嗅探直链和 m3u8、直链保存、HLS 点播（多清晰度、MPEG-TS、fMP4、AES-128、音视频分轨）封装成 MP4。直播和 DASH 只展示，不下载。

封装使用随扩展打包的 `@ffmpeg/core`。这个包是 GPL 构建；仓库若发布，许可证需要按 GPL 处理，许可证文本在构建时复制到 `public/ffmpeg/LICENSE.txt`。

公开验收可以用 [Mux 测试流](https://test-streams.mux.dev/)。只保存你有权下载的内容。
