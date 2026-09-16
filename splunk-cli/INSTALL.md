# splunk-cli 安装指南

<div style="margin: 8px 0 16px;">
  <span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: #fff; font-size: 12px; font-weight: 500; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; box-shadow: 0 2px 8px rgba(59,130,246,0.3);">
    <span style="width: 6px; height: 6px; border-radius: 50%; background: #fff;"></span>
    author: Alex
  </span>
</div>

> 面向自动化场景的安装步骤。完整用法见 [USAGE.md](./USAGE.md)，版本历史见 [VERSION.md](./VERSION.md)。

## 包信息

| 项目 | 值 |
| --- | --- |
| 包名 | `splunk-cli` |
| 安装包 | `splunk-cli.tgz` |
| 格式 | npm 安装包（tgz），**一个文件跨平台** |
| 前置依赖 | **Node.js >= 20** 与 `npm` |
| 安装后命令 | `splunk-cli` |

---

## 一、TL;DR

```bash
node -v                                    # 需要 >= v20
npm install -g ./splunk-cli.tgz            # 在交付目录（含 splunk-cli.tgz 的目录）下执行
splunk-cli init                            # 创建配置目录与模板
$EDITOR ~/.splunk-cli/config.env           # 填 SPLUNK_HOST / USERNAME / PASSWORD
splunk-cli health                          # 验证连通性、TLS 与凭据
```

> **如果 `health` 报 `self-signed certificate in certificate chain`**：这不是网络或密码问题。
> 校验默认是**开启**的（`SPLUNK_VERIFY_SSL=true`），而 Splunk 默认安装的证书
> （`SplunkServerDefaultCert`）由 Splunk 自己的 CA 签发、且没有 SAN 扩展。两个办法：
>
> ```bash
> # ~/.splunk-cli/config.env
> # 办法一（推荐）：信任签发服务端证书的 CA
> #   要放服务端发出的**整条链**，只放叶子证书无法建立信任
> SPLUNK_CA_BUNDLE=/path/to/splunk-ca.pem
>
> # 办法二（仅开发环境）：跳过身份校验；连接**仍然加密**
> SPLUNK_VERIFY_SSL=false
> ```
>
> 另注意：Splunk 默认证书**没有 SAN**，所以按 IP 连接时就算配了 CA，也会改成报
> `Hostname/IP does not match certificate's altnames`（**CN 不参与 IP 匹配**）。
> 详见 [USAGE.md 的 TLS 一节](./USAGE.md)。

后续升级：再次 `npm install -g ./splunk-cli.tgz`，然后重跑一次 `splunk-cli health`。

---

## 二、安装包说明

### 2.1 目录内容

```text
splunk-cli/                          ← 交付目录
├── INSTALL.md                       ← 本文件
├── USAGE.md                         ← 完整使用手册
├── VERSION.md                       ← 版本更新记录
└── splunk-cli.tgz                   ← 安装包
```

### 2.2 一个文件跨平台

`npm install -g ./splunk-cli.tgz` 在 macOS / Linux / Windows 上用法完全相同：包里只有本项目
**打包压缩后的产物**，第三方依赖由目标机的 `npm` 按平台自行解析安装。

### 2.3 关于源码保护

安装包里不含 `.ts` 源码，也不含 source map：构建时打成压缩单文件，解包后无法还原可读源码。

---

## 三、安装

### 3.1 确认环境

```bash
node -v     # 需要 >= v20
npm -v
```

### 3.2 安装

```bash
cd splunk-cli
npm install -g ./splunk-cli.tgz
```

> Windows 用户：npm 包格式（tgz）跨平台通用，PowerShell / CMD 均可直接安装。
> CMD 更习惯写 `.\splunk-cli.tgz`，与 `./splunk-cli.tgz` 指向同一个文件。

若企业环境不允许全局安装，也可以装到本地目录后用 `npx` 调用：

```bash
npm install ./splunk-cli.tgz
npx splunk-cli --version
```

### 3.3 升级

```bash
npm install -g ./splunk-cli.tgz        # 覆盖安装即可，无需先卸载
splunk-cli --version                   # 应等于交付目录里的版本
```

### 3.4 验证安装

```bash
splunk-cli --help          # 列出全部子命令
splunk-cli limits          # 打印生效中的安全上限与 Job 运行预算（不需要连上 Splunk）
```

### 3.5 可视化面板

面板随包安装，不需要额外步骤：

```bash
splunk-cli dashboard                    # 默认 http://127.0.0.1:8765
splunk-cli dashboard --port 9000
```

面板与 CLI **共用同一套服务层**，因此数据完全一致；它只绑定回环地址，且完全只读。

---

## 四、首次配置

### 4.1 创建配置目录

```bash
splunk-cli init
```

会创建 `~/.splunk-cli/`（权限 `700`）并在其中写入 `config.env`（权限 `600`）。
**已有配置绝不覆盖**，重复执行是安全的。

> 配置目录里只有配置文件本身，不放 README 之类的说明文档——产品文档就是本目录下的
> `INSTALL.md` / `USAGE.md`。

### 4.2 填写连接信息

编辑 `~/.splunk-cli/config.env`，至少填三项：

```bash
# Splunk 主机名或 IP，不带协议、不带端口
# 示例：splunk.internal（主机名）、10.0.0.5（IP）
SPLUNK_HOST=203.0.113.10

# REST API 管理端口，通常是 8089（注意：8000 是 Web UI 端口，不是 API）
SPLUNK_PORT=8089

# Splunk 账号名。示例：admin（内置管理员）、ci_reader（建议用专用的只读账号）
SPLUNK_USERNAME=splunk_user
SPLUNK_PASSWORD=在此填写密码

# TLS 校验。默认开启：客户端会验证服务端身份。连接**始终加密**，
# false 只跳过"证明对端身份"这一步。
# Splunk 默认安装的证书由 Splunk 自己的 CA 签发、且没有 SAN，所以对默认安装会失败：
# 按下面的说明配好 CA，或把本行改成 false（仅开发环境）。
SPLUNK_VERIFY_SSL=true

# 可选：CA 证书路径。开启校验且证书不是公共 CA 签发时必须配。
# 要放服务端发出的**整条链**（叶子 + 签发它的 CA），只放叶子无法建立信任。
# SPLUNK_CA_BUNDLE=/path/to/splunk-ca.pem
```

Splunk 默认证书由 Splunk 自己的 CA 签发、且没有 SAN，因此对接默认安装时要么配
`SPLUNK_CA_BUNDLE`（必须含**签发服务端证书的那个 CA**），要么在开发环境设
`SPLUNK_VERIFY_SSL=false`。注意按 IP 连接时即使配了 CA 也会因缺少 SAN 失败——**CN 永远不参与
IP 匹配**（详见 USAGE.md 的 TLS 一节）。

### 4.3 验证配置与连接

```bash
splunk-cli config          # 打印生效配置，密码只显示 <set> / <unset>
splunk-cli health          # 验证连通性、TLS 与凭据
```

`health` 成功时会打印版本、server name、license 状态与探针延迟。

### 4.4 用环境变量覆盖（CI 推荐）

环境变量优先级最高，适合流水线里临时覆盖：

```bash
export SPLUNK_HOST=splunk.internal
export SPLUNK_USERNAME=ci_reader
export SPLUNK_PASSWORD=...
export SPLUNK_VERIFY_SSL=true
export SPLUNK_CA_BUNDLE=/etc/ssl/certs/splunk-ca.pem   # 开启校验就必须配 CA
splunk-cli health --json
```

CI 里请把密码放进 secret 注入的环境变量，**不要写进命令行参数**。

---

## 五、卸载

```bash
npm uninstall -g splunk-cli
```

如需一并清理本地配置与凭据：

```bash
rm -rf ~/.splunk-cli
```

---

## 六、常见安装问题

| 现象 | 原因与处理 |
| --- | --- |
| `node: command not found` / 版本过低 | 需要 Node >= 20；装好后重开终端 |
| `npm ERR! code EACCES` | 全局目录无写权限：改用 `npm install ./splunk-cli.tgz` + `npx splunk-cli`，或修正 npm 全局前缀 |
| `splunk-cli: command not found` | 全局 bin 目录不在 `PATH`；用 `npm prefix -g` 查看位置 |
| `missing required configuration` | 缺 `SPLUNK_HOST` / `SPLUNK_USERNAME` / `SPLUNK_PASSWORD`；`splunk-cli config` 会指出缺哪一项 |
| `self-signed certificate in certificate chain` | 校验默认开启，而 Splunk 默认证书是自签的（`SplunkServerDefaultCert`）：按 §四 配好 `SPLUNK_CA_BUNDLE`，或在开发环境设 `SPLUNK_VERIFY_SSL=false`。**与网络、密码无关** |
| `Hostname/IP does not match certificate's altnames` | 证书没有覆盖你连接名字的 SAN（Splunk 默认证书就是如此）：按 IP 连接时配 `SPLUNK_CA_BUNDLE` 也没用，只能换成带 SAN 的证书或在开发环境设 `SPLUNK_VERIFY_SSL=false` |
| `authentication failed (HTTP 401)` | 凭据错误，或该账号无权读取 `/services/server/info` |
| 连接被拒绝 / 超时 | 确认端口是 8089、网络可达；`splunk-cli health --verbose` 看细节 |
| 面板打不开 | `dashboard` 只绑定 `127.0.0.1`，请在**运行它的那台机器**上访问 |
