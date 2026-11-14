import { defineConfig } from "wxt";

// ffmpeg.wasm 写文件时会 transfer ArrayBuffer。Windows 的扩展页面里，对端因此收到 undefined。
function ffmpegNoTransfer() {
  return {
    name: "ffmpeg-no-transfer",
    transform(code: string, id: string) {
      if (!id.includes("@ffmpeg/ffmpeg") || !id.includes("classes.js")) return;
      const from = `if (data instanceof Uint8Array) {
            trans.push(data.buffer);
        }
        return this.#send({
            type: FFMessageType.WRITE_FILE,
            data: { path, data },
        }, trans, signal);`;
      const to = `return this.#send({
            type: FFMessageType.WRITE_FILE,
            data: { path, data },
        }, [], signal);`;
      if (!code.includes(from)) throw new Error("ffmpeg writeFile 源码变了，Windows 补丁没有打上");
      return code.replace(from, to);
    },
  };
}

export default defineConfig({
  srcDir: ".",
  // 不用默认的 .output：Chrome「加载已解压的扩展程序」文件选择器不显示点开头的目录。
  outDir: "output",
  vite: () => ({ plugins: [ffmpegNoTransfer()] }),
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
    action: {
      default_title: "视频下载",
    },
    content_security_policy: {
      // ffmpeg.wasm 在 offscreen 里编译 WebAssembly，默认 CSP 会拦住。
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
  },
});
