# 发布与维护流程

面向仓库维护者。普通用户看 [README](../README.md) 即可。

## 1. 发布前检查

```powershell
npm test                     # 21 项离线 mock-host 自检
node --check index.js        # 语法检查
npm pack --dry-run           # 确认只打包运行必需文件（约 20 KB / 8 个文件）
```

版本号遵循语义化版本；宿主 DSH 升级时同步更新 `package.json` 的 `engines.dsh`。

## 2. 打 tag 与 GitHub Release

```powershell
# 改 package.json 版本号并提交
git add -A
git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z

npm run pack:dist            # → dist/dsh-session-mesh-X.Y.Z.tgz

# 用 GitHub CLI 建 Release（也可以网页操作）
gh release create vX.Y.Z dist/dsh-session-mesh-X.Y.Z.tgz \
  --repo kx2398/dsh-session-mesh \
  --title "dsh-session-mesh vX.Y.Z" \
  --notes-file dist/release-notes-vX.Y.Z.md
```

Release 附件就是给离线安装用的 tgz，安装方式：

```text
plugin_manager install_bundle  target = github:kx2398/dsh-session-mesh#vX.Y.Z
plugin_manager install_bundle  target = file:C:/.../dsh-session-mesh-X.Y.Z.tgz
```

## 3. CI

`.github/workflows/test.yml` 在 push / PR 时执行：

1. `node --check index.js`
2. `npm test`
3. `npm pack --dry-run`

## 4. 跨机器/安装排错速查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 安装被拒：DSH 版本不满足 | `engines.dsh` 检查 | 升级目标机 DSH，或调整 `engines.dsh` 后重新发布 |
| 安装成功但插件 `failed` | profile 缺少 `sessionController` 等 Host 服务（headless/SDK），或包名/入口不对 | 换 desktop/web profile；查看 Plugin Manager 诊断 |
| 工具不出现 | 装到了另一个 profile，或未重载 | 在目标 profile 里 disable→enable；重启 DSH |
| 目录移动后插件失效 | 目录拷贝是 `link:` 安装 | 重新 `install_bundle` 指向新路径，或改用 tarball |
| 升级同版本不生效 | 同版本号已安装 | `remove_bundle` → 再 `install_bundle` |
| git 安装失败 | 目标机无法访问 GitHub | 下载 Release 里的 tgz 离线安装 |
