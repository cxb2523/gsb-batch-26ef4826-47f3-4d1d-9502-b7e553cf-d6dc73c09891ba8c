// Read the draft body from stdin and append the installation section before publishing.
import { readFileSync } from "node:fs";

const [repository, tag] = process.argv.slice(2);
if (!repository || !/^v\d+(\.\d+){1,3}$/.test(tag)) {
  throw new Error("Expected a GitHub repository and a numeric version tag");
}

const base = `https://github.com/${repository}`;
const zip = `${base}/releases/download/${tag}/BilibiliLiveDelay-${tag}.zip`;
const body = readFileSync(0, "utf8").trimEnd();
const section = `### 下载与安装

- **Edge**：[从 Microsoft Edge 扩展商店安装](https://microsoftedge.microsoft.com/addons/detail/ijgpaikhpfjjmiimfocfnjbamigokgih)，无需开发者模式。
- **Chrome**：[下载 ${tag} 扩展 ZIP](${zip})。解压后，在扩展管理页开启「开发者模式」，点击「加载已解压的扩展程序」，选择含有 \`manifest.json\` 的文件夹。

CRX 适用于 Linux 版 Chrome、企业策略部署或支持本地 CRX 的浏览器。[详细安装说明](${base}#quick-start)`;
console.log([body, section].filter(Boolean).join("\n\n"));
