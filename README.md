# npm Registry Trusted Sync

一个利用 github runner 把私有 npm-compatible registry 中的 npm 包同步发布到 npmjs的工具。

只使用 npm Trusted Publishing，不使用 npm token。

## 行为边界

- 从源 registry 读取 `versions` 和 `dist-tags`，并要求源 registry 必须有 `latest` dist-tag。
- 从 npmjs 读取已发布 versions 和当前 dist-tags。
- 元数据读取使用 `npm view ... --json --registry`，与 `npm pack` 复用同一个临时 `.npmrc`。
- `PACKAGE_NAME` 是源 registry 上的包名；设置 `TARGET_PACKAGE_NAME` 后，npmjs 查重和发布都使用目标包名。
- GitHub Actions 日志会隐藏源 registry URL、源包名和源 registry token。
- 只发布源 registry 有、npmjs 没有的版本。
- 历史版本按 semver 升序发布，并始终使用 `HISTORICAL_PUBLISH_TAG`，默认是 `sync`。
- 源 registry 的 `latest` 指向版本最后发布，并使用 `--tag latest`。
- 不执行 `npm dist-tag add`。
- 不同步非 `latest` 的 dist-tag。
- 不删除 npmjs 上任何版本或 tag。
- 如果 npmjs 已有 source latest 版本，但 npmjs 的 `latest` tag 没有指向它，脚本只输出 warning。Trusted Publishing-only 模式无法修复既有版本的 `latest` tag，因为本工具不会执行 `npm dist-tag add`，也不会使用 token fallback。

这能避免补历史版本时把 npmjs 的 `latest` 推回旧版本。

## 配置

fork 本项目, 并启用github的action, 然后在 GitHub 仓库的 Variables 和 Secrets 中配置：

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `SOURCE_REGISTRY_URL` | Variable | 无 | 私有 npm-compatible registry URL。 |
| `SOURCE_REGISTRY_TOKEN` | Secret | 无 | 读取源 registry 和 `npm pack` 使用的 token。 |
| `PACKAGE_NAME` | Variable | 无 | 源 registry 上的 npm 包名，例如 GitLab 中的 `@internal/pkg`。 |
| `TARGET_PACKAGE_NAME` | Variable | `PACKAGE_NAME` | 发布到 npmjs 的包名。设置后会把包内 `package.json.name` 改成这个值。 |
| `TARGET_REGISTRY_URL` | Variable | `https://registry.npmjs.org` | 目标 npmjs registry URL。 |
| `TARGET_REPOSITORY_URL` | Variable | 无 | 发布前写入包内 `package.json` 的 `repository.url`。 |
| `TARGET_ACCESS` | Variable | `public` | npm publish access，取值为 `public` 或 `restricted`。私有 scoped 包使用 `restricted`。 |
| `HISTORICAL_PUBLISH_TAG` | Variable | `sync` | 历史版本发布 tag，不能是 `latest`。 |
| `DRY_RUN` | Variable | `false` | 设为 `true` 时只计算计划，不 pack、不 publish。 |

`workflow_dispatch` 也提供 `dry_run` 输入，手动运行时会覆盖仓库变量中的 `DRY_RUN`。

## Trusted Publishing 设置

1. 在 npmjs 上打开目标 package 的 settings。
2. 配置 Trusted Publisher，选择 GitHub Actions。
3. 填写这个同步仓库的 owner、repository、workflow 文件名 `.github/workflows/sync.yml`。
4. 确认 workflow 使用 GitHub-hosted runner，例如 `ubuntu-latest`。

workflow 已包含 Trusted Publishing 需要的权限：

```yaml
permissions:
  contents: read
  id-token: write
```

workflow 使用 `actions/setup-node` 和 Node.js 24/npm 11，不设置 `NODE_AUTH_TOKEN` 或 npmjs token。

参考文档：

- npm Trusted Publishers: <https://docs.npmjs.com/trusted-publishers>
- actions/setup-node: <https://github.com/actions/setup-node>

## 私有 registry 认证

脚本会在临时目录写入 `.npmrc`，只包含源 registry 的认证信息：

```text
//registry.example.com/path/to/npm/:_authToken=***
//registry.example.com/path/to/npm/:always-auth=true
```

auth key 会保留 registry path，不会退化成只有 host 的形式。脚本不会输出 token，也不会输出完整 `.npmrc`。

发布到 npmjs 时仍使用同一个临时 userconfig，但里面不会写入 npmjs token。子进程环境中也会移除常见 npm token 环境变量，避免 token fallback。

## 日志脱敏

脚本会在 GitHub Actions 中注册 mask，隐藏：

- `SOURCE_REGISTRY_URL`
- `PACKAGE_NAME`
- `SOURCE_REGISTRY_TOKEN`

脚本自己的 summary、warning 和 error 文本也会把这些值替换为占位符。设置 `TARGET_PACKAGE_NAME` 后，目标 npmjs 包名仍会正常显示；源包名不会显示。

## 每个版本的处理方式

发布每个缺失版本前，脚本会：

1. 执行 `npm pack <PACKAGE_NAME>@<version> --registry <source>` 从源 registry 拉取 tarball。
2. 解压 tarball。
3. 只修改 `package/package.json`：
   - `name = TARGET_PACKAGE_NAME || PACKAGE_NAME`
   - `repository.type = "git"`
   - `repository.url = TARGET_REPOSITORY_URL`
4. 不修改 `version`。
5. 不修改业务文件。
6. 重新打包后执行 `npm publish <tgz> --registry <target> --tag <tag> --access <TARGET_ACCESS>`，默认 `public`。

重新打包使用 `tar`，不会运行包内的 npm lifecycle scripts，也不会构建业务项目。

## 本地运行

```bash
npm ci
SOURCE_REGISTRY_URL='https://registry.example.com/npm/' \
SOURCE_REGISTRY_TOKEN='***' \
PACKAGE_NAME='@internal/pkg' \
TARGET_PACKAGE_NAME='@scope/pkg' \
TARGET_REPOSITORY_URL='https://github.com/acme/pkg.git' \
DRY_RUN=true \
npm run sync
```

本地真实发布通常不会有 GitHub Actions OIDC 环境，因此 Trusted Publishing 发布应在 GitHub Actions runner 中执行。

## 输出 summary

每次运行都会输出 summary，并写入 GitHub Actions step summary：

- source package name，占位显示
- target package name
- source latest version
- npmjs latest version
- missing versions
- published historical versions
- published latest version
- warnings/errors

历史版本 `npm pack` 失败会记录 warning 并继续处理其他版本。`npm publish` 如果报告版本已存在，会按幂等成功处理。
