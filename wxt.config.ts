import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: ".",
  // 不用默认的 .output：Chrome「加载已解压的扩展程序」文件选择器不显示点开头的目录。
  outDir: "output",
  manifest: {
    name: "视频下载",
    description: "嗅探当前页的视频和音频。直链直接保存，HLS 点播在本地封装成 MP4。",
    permissions: [
      "webRequest",
      "downloads",
      "storage",
      "unlimitedStorage",
      "offscreen",
      "scripting",
      "tabs",
      "declarativeNetRequest",
      "declarativeNetRequestWithHostAccess",
    ],
    // 安装时不申请任何站点。用户在弹层里授权后，才注册页面脚本。
    // host_permissions 必须留空：WXT 看到 content script 入口且 matches 为全站时，会自动写成 *://*/*。
    optional_host_permissions: ["http://*/*", "https://*/*"],
    host_permissions: [],
    icons: {
      16: "icon/mark-16.png",
      32: "icon/mark-32.png",
      48: "icon/mark-48.png",
      128: "icon/mark-128.png",
    },
    action: {
      default_title: "视频下载",
      default_icon: {
        16: "icon/mark-16.png",
        32: "icon/mark-32.png",
        48: "icon/mark-48.png",
        128: "icon/mark-128.png",
      },
    },
    content_security_policy: {
      // ffmpeg.wasm 在 offscreen 里编译 WebAssembly，默认 CSP 会拦住。
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
  },
});
